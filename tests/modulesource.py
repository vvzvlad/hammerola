"""Where a module's code came from — for the sweeps that judge scratch projects.

THREE PREDICATES ASKED THIS AND ALL THREE ASKED IT WITH `__file__` ALONE, which
a NAMESPACE PACKAGE has not got. `import mocks` over a `mocks/` directory with no
`__init__.py` binds a module whose `__file__` is None and whose location lives in
`__path__`, so `(getattr(module, "__file__", None) or "").startswith(base)` was
false for it — every sweep walked past, and the module stayed in `sys.modules`
answering every later `import mocks` in the session, from a directory that had
since been deleted. The three were `hub_verdict`'s sweep and the
`no_model_left_in_the_interpreter` fixture in `tests/test_template.py`, and
`_importable` in `tests/cadbuild/test_provenance.py`.

NOT AN EXOTIC SHAPE, which is why this is fixed rather than noted.
`geometry.load_model` puts a model project's own root FIRST on sys.path
deliberately — its comment says so: "because `import mocks` in a model.py has to
find the project's own mocks.py" — and a project that keeps its mocks in a
DIRECTORY rather than in one file is exactly this.

A MODULE OF ITS OWN rather than a few lines in `tests/conftest.py`, for the
reason `tests/buildproc/probes.py` gives about itself: three directories under
tests/ carry a conftest.py and every one of them lands on sys.path, so
`import conftest` from a test module resolves to whichever of the three pytest
inserted first. This one is imported from two directories — `tests/` and
`tests/cadbuild/` — and it reaches the second because loading `tests/conftest.py`
puts `tests/` on sys.path for any run that collects anything underneath it.
"""

import os
import sys


def _as_path(value):
    """`value` as a path string, or None if it is not one at all.

    `os.fspath` and not `isinstance(value, str)`, which is what stood here: an
    importer, a stub or a test that sets `__file__` to a `pathlib.Path` is
    setting it to a perfectly ordinary path, and the isinstance check dropped
    it silently — so the module became INVISIBLE to every sweep and stayed in
    `sys.modules` for the rest of the session. That is the same failure the
    namespace-package hole above produced, arrived at from the other side, and
    a `Path` in `__file__` is the more likely of the two to be written by
    somebody's test.

    A `bytes` path comes back as None rather than as bytes: `os.fspath` passes
    bytes through unchanged, and `came_from` would then compare bytes against a
    str `base` and raise TypeError inside a sweep. Encoded paths are legal to
    the OS and are not a thing this repository's sweeps have ever seen.
    """
    try:
        path = os.fspath(value)
    except TypeError:
        return None
    return path if isinstance(path, str) else None


def module_locations(module):
    """Every path this module's code could have been loaded from.

    `__file__` AND `__path__`, never one or the other. An ordinary module has
    only the first, a regular package has both, and a NAMESPACE package has only
    the second — which is the whole reason this function exists.

    Neither attribute is guaranteed to be what it usually is: a namespace
    package's `__path__` is a `_NamespacePath` rather than a list, and both are
    ordinary writable names an importer or a stub may have set to something
    else. A sweep that raised while deciding whether to sweep would fail the
    test that ran, which is the one place this must not put a failure.

    A STRING `__path__` IS REFUSED WHOLE, and that is not pedantry: a string is
    iterable, and every character of one is a string, so `__path__ = "abcdef"`
    used to come back as `['a', 'b', 'c', 'd', 'e', 'f']` — six one-character
    locations, each of which `came_from` then compared as a path. `bytes` is
    refused for the same reason and would otherwise be dropped element by
    element anyway (its elements are ints).
    """
    locations = []
    for attribute in ("__file__", "__path__"):
        value = getattr(module, attribute, None)
        if attribute == "__file__":
            entries = (value,)
        elif isinstance(value, (str, bytes)) or value is None:
            continue
        else:
            try:
                entries = list(value)
            except TypeError:
                # `__path__` set to something that is not iterable at all.
                continue
        locations.extend(path for path in map(_as_path, entries)
                         if path is not None)
    return locations


def came_from(module, base):
    """Did any of this module's code come from under `base`?

    `+ os.sep` AND NOT A BARE PREFIX, which is what stood here: `/tmp/proj-x`
    starts with `/tmp/proj` and is a different directory, so a sweep over one
    scratch project deleted the modules of another that happened to be named
    with it as a prefix. `tmp_path` names are `test_a_thing_0`,
    `test_a_thing_1`, so two projects of one run are exactly that shape — and
    the sweep runs in a `finally`, so what it deleted is discovered by whichever
    test runs next. The equal case counts too: a namespace package whose
    `__path__` entry IS the root came from it as much as anything under it did.
    """
    return any(location == base or location.startswith(base + os.sep)
               for location in module_locations(module))


def modules_from(base):
    """The names in `sys.modules` answering with code from under `base`, sorted.

    A snapshot of the items, because the caller is about to delete from the very
    dict this walks. `None` values are skipped: `sys.modules` holds one for a
    submodule import that failed part way, and it is not a module to judge.
    """
    return sorted(name for name, module in list(sys.modules.items())
                  if module is not None and came_from(module, base))
