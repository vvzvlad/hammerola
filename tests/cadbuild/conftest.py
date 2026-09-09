"""Fixtures shared by the build-half suite, and by nothing else.

Scoped to this directory on purpose. `isolated_project` is AUTOUSE, so it would
otherwise chdir every hub test in the repository into a scratch directory and
pin a project root none of them have -- the two suites test different things and
must not share a conftest. The hub's own fixtures live one level up in
tests/conftest.py and reach here too (they are not autouse, so nothing in this
directory picks them up by accident); the `hub` and `hub_factory` fixtures there
start a real server, and nothing under cadbuild/ has any use for one.

Nothing here touches the network, a docker daemon or a CAD kernel. Every test in
this directory runs on a python that has none of them, because the logic worth
pinning down -- the palette, the naming rules, the gates, the diff -- is all
pure.

THE SETTINGS HALF OF THE ORIGINAL FIXTURE IS GONE, and that is the transfer
rather than a simplification. In cad_publish this fixture also pointed
`MACHINE_ENV_FILE` at a file that does not exist, cleared HUB_URL /
EDIT_TOKEN / BUILD_CONTEXT / BUILD_IMAGE out of the environment, emptied the
settings caches and stubbed out `token_from_vault` -- because that package read
a developer's ~/.config/3d/env and could unlock a real Vaultwarden. src.cadbuild
resolves no setting and holds no credential: the whole client side, settings.py
included, stayed in cad_publish (see src/cadbuild/__init__.py). There is
nothing left here to isolate from.

Read those four names as history rather than as a contract with anything here.
They described the CLIENT's world -- the hub it pushed a finished build to, and
the build node it built on -- and nothing under src/cadbuild reads any of them.
EDIT_TOKEN is the one worth pointing at, because the hub does read a secret
by that name: it reads it through src/settings.py, which is a different module
from the settings.py that stayed behind.
"""

import json

import pytest

from src.cadbuild import checklib, paths


@pytest.fixture(autouse=True)
def guard_module_state():
    """Fail the test that dirties shared state, not the one that trips over it.

    Five pieces of module-level mutable state live in this package, and every
    one of them is read by something far away from where it is written:

      * `paths._root` -- the project this run is about. Set by the fixture
        below and by any test that pins a root of its own; left behind, it
        makes every later test resolve paths against a tmp_path that has been
        deleted.
      * `checklib._INTERFERENCE` -- the volumes pairwise_interference measured.
        It ACCUMULATES over a run by design (a model may call the check once
        per subassembly), and `collect_metrics` copies whatever is in it into
        metrics.json. A test that measures an overlap and does not clear it
        therefore turns up inside an unrelated test's metrics.
      * `checklib._SECTIONS` -- what each `with checklib.section(...)` block of
        checks() cost. Accumulates for the same reason and is read by the same
        kind of distant reader: `modelchecks.run_checks` prints it in a
        `finally`, so a section left behind by one test comes out in the log of
        every later test that runs checks, attached to a run that never
        measured it.
      * `checklib._UNITS` -- the checks `@checklib.check` registered. Read in
        two places far from any test that fills it: `run_checks` consults it
        before refusing an empty `checks()`, and `checkunits.run_units` STARTS
        PROCESSES for whatever is in it. A unit left behind is therefore a unit
        some later test's build spawns a worker to run, against a model that
        never defined it.
      * `checklib._CLEARANCE` -- what swept_clearance measured along each pair's
        travel: the stops, the tightest gap and where it was. Accumulates like
        the two above (a model sweeps one pair per degree of freedom) and is
        read back by `recorded_clearance()`, so a gap left behind is a pair a
        later test never swept. Its distant reader is `collect_metrics`, which
        publishes it as `assembly.clearance` -- exactly the same distance
        `_INTERFERENCE` is read from, and the same failure: a gap left behind
        turns up inside an unrelated test's metrics.

    `isolated_project` REQUESTS this fixture by name rather than merely being
    declared after it, and that is the only thing that gets the ordering right:
    two autouse fixtures of the same scope have no guaranteed order between
    them, so without the dependency this check can run inside the window where
    `isolated_project` legitimately holds a project root -- which it does for
    the whole of every test -- and then fails on every test in the directory.
    Made a dependency, it is set up first and torn down last, so what it sees
    is the state either side of that fixture rather than the middle of it.

    Both ends matter. A test that dirties shared state and does not restore it
    PASSES -- it has done its own job -- and the failure surfaces later, in
    some unrelated test that assumed a clean start, usually in another file and
    reliably never when that test is run on its own.
    """
    assert (paths._root is None and checklib._INTERFERENCE == {}
            and checklib._SECTIONS == {} and checklib._CLEARANCE == {}
            and checklib._UNITS == {}), (
        "src.cadbuild module state was already dirty when this test started, so "
        "an EARLIER test left it behind; this test is where it surfaced, not "
        "where it was caused")
    yield
    assert (paths._root is None and checklib._INTERFERENCE == {}
            and checklib._SECTIONS == {} and checklib._CLEARANCE == {}
            and checklib._UNITS == {}), (
        "this test left src.cadbuild module state behind (paths._root, "
        "checklib._INTERFERENCE, checklib._SECTIONS, checklib._CLEARANCE or "
        "checklib._UNITS). Without this assertion the failure would have landed "
        "on some unrelated test later, under one particular collection order")


@pytest.fixture(autouse=True)
def isolated_project(guard_module_state, tmp_path, monkeypatch):
    """A scratch project to run against, and never the directory pytest started in.

    Without it a test that calls anything path-shaped resolves against whatever
    directory pytest was started in -- which during development is this very
    repository, and `find_project_root` would walk up out of it looking for a
    project.json.
    """
    root = tmp_path / "scratch-project"
    root.mkdir()
    (root / "project.json").write_text(
        json.dumps({"id": "abc123def456", "title": "Тестовая деталь (scratch-project)"}),
        encoding="utf-8",
    )
    monkeypatch.chdir(root)
    paths.set_project_root(root)

    yield root

    paths.set_project_root(None)


@pytest.fixture
def out_dir(isolated_project):
    """An empty `_out/` inside the scratch project."""
    path = isolated_project / "_out"
    path.mkdir()
    return path
