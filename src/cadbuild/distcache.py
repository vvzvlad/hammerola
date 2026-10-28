#!/usr/bin/env python3
"""Distances an earlier build of the same project measured, answered again.

A model's checks spend most of a build measuring distances between bodies --
`Shape.distance` in CadQuery, `BRepExtrema_DistShapeShape` straight from model
code, `checklib.swept_clearance` -- and most of those bodies are byte for byte
the ones the previous build measured (SPEC §4, the row on distances measured in
a build). For the rest of the process `install` puts a subclass in place of the
kernel's class, under both names it is looked up by, whose `Perform` first asks
a per-project sqlite file.

The key is the content of both shapes as the kernel took them in `LoadS1` and
`LoadS2` -- their `BinTools` bytes, location and triangulation included, written
at that moment -- plus every setting that can change the answer and the
kernel's version. A body moved, or a compound added to, after one measurement
is therefore a new key at the next load, and two mesh-only faces that differ
only in their triangles are two keys. Only `Value()` is stored: an accessor of
the solution itself (points, supports, parameters) first runs the real
computation, for the state the stored answer was given for.

The cache is never the reason a build fails: a sqlite or OS error is one
warning line in the build log, and the build goes on computing without it.

No kernel import at module level: `src/buildproc/child.py` imports this module,
and tests/buildproc asserts the pytest process never imports OCP.
"""

import hashlib
import importlib.metadata
import io
import sqlite3
import sys
from pathlib import Path

# Part of every key: a change to what a stored row means changes this, and the
# old rows stop matching instead of answering.
SCHEMA = "distance-v1"

_NAME = "BRepExtrema_DistShapeShape"
# cadquery imports the name at its own import, so patching OCP alone misses
# `Shape.distance`.
_MODULES = ("OCP.BRepExtrema", "cadquery.occ_impl.shapes")

# What a stored answer does not hold: these need the kernel's own solution.
_SOLUTION = ("NbSolution", "InnerSolution", "PointOnShape1", "PointOnShape2",
             "SupportTypeShape1", "SupportTypeShape2", "SupportOnShape1",
             "SupportOnShape2", "ParOnEdgeS1", "ParOnEdgeS2", "ParOnFaceS1",
             "ParOnFaceS2", "Dump")

_original = None        # the kernel's class, while the subclass stands in for it
_connection = None
_path = None
_version = None
_hits = 0
_total = 0
_warned = False


def install(path):
    """Answer distances from the cache at `path` for the rest of this process.

    A cache that cannot be opened is a warning and no patch: every distance is
    then computed as if this were never called.
    """
    global _original, _connection, _path, _version
    import cadquery.occ_impl.shapes  # noqa: F401 -- one of the two names patched
    import OCP.BRepExtrema

    version = importlib.metadata.version("cadquery-ocp")
    connection = None
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(path), isolation_level=None)
        # First, so the switch to WAL waits out another build holding the file.
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("CREATE TABLE IF NOT EXISTS distance "
                           "(key BLOB PRIMARY KEY, value REAL)")
    except (sqlite3.Error, OSError) as exc:
        if connection is not None:
            connection.close()
        _warn(path, exc)
        return
    _connection = connection
    _path = path
    _version = version
    _original = OCP.BRepExtrema.BRepExtrema_DistShapeShape
    cached = _cached_class(_original)
    for name in _MODULES:
        setattr(sys.modules[name], _NAME, cached)


def uninstall():
    """Put the kernel's class back and forget everything `install` remembered."""
    global _original, _connection, _path, _version, _hits, _total, _warned
    if _original is not None:
        for name in _MODULES:
            setattr(sys.modules[name], _NAME, _original)
    if _connection is not None:
        _connection.close()
    _original = _connection = _path = _version = None
    _hits = _total = 0
    _warned = False


def installed_path():
    """The cache this process answers from, or None."""
    return _path


def counts():
    """`(hits, total)`: distances taken from the cache, and all measured."""
    return _hits, _total


def _warn(path, exc):
    """The one line a failing cache leaves in the build log. Never raises."""
    global _warned
    if _warned:
        return
    _warned = True
    try:
        print(f"warning: distance cache {path}: {type(exc).__name__}: {exc}; "
              f"distances are computed without it", flush=True)
    except Exception:  # a model can close stdout
        pass


def _fail(exc):
    """Stop using the cache for the rest of the process."""
    global _connection
    connection, _connection = _connection, None
    try:
        connection.close()
    except sqlite3.Error:
        pass
    _warn(_path, exc)


def _digest(shape):
    """sha256 of the shape's BinTools bytes, or None when it will not write.

    Written afresh on every load and never remembered: a shape is mutable in
    place (`move`, `BRep_Builder.Add`), so a digest kept for its wrapper goes
    stale without anything noticing.
    """
    from OCP.BinTools import BinTools, BinTools_FormatVersion_CURRENT
    stream = io.BytesIO()
    try:
        BinTools.Write_s(shape, stream, True, False,
                         BinTools_FormatVersion_CURRENT)
    except Exception:
        return None
    return hashlib.sha256(stream.getvalue()).hexdigest()


def _key(state):
    """The row a measurement in `state` is stored under, or None if uncacheable."""
    loaded1, loaded2, flag, algo, deflection, multithread = state
    if loaded1 is None or loaded2 is None:
        return None
    digests = (loaded1[1], loaded2[1])
    if None in digests:
        return None
    parts = (SCHEMA, _version, *digests, str(int(flag)), str(int(algo)),
             "default" if deflection is None else repr(float(deflection)),
             str(bool(multithread)))
    return hashlib.sha256("\n".join(parts).encode()).digest()


def _lookup(key):
    try:
        row = _connection.execute("SELECT value FROM distance WHERE key = ?",
                                  (key,)).fetchone()
    except (sqlite3.Error, OSError) as exc:
        _fail(exc)
        return None
    return None if row is None else row[0]


def _store(key, value):
    if _connection is None:
        return
    try:
        _connection.execute("INSERT OR REPLACE INTO distance (key, value) "
                            "VALUES (?, ?)", (key, value))
    except (sqlite3.Error, OSError) as exc:
        _fail(exc)


def _cached_class(base):
    """A subclass of the kernel's `base` whose `Perform` asks the cache first.

    Load*/Set* go to the kernel at once and are recorded. Like the kernel's,
    the last answer stands until the next `Perform`, whatever is loaded or set
    in between; `_solve` therefore computes for the state that answer was for.
    """
    from OCP.Extrema import Extrema_ExtAlgo_Grad, Extrema_ExtFlag_MINMAX
    from OCP.Precision import Precision
    from OCP.TopLoc import TopLoc_Location

    def taken(shape):
        """`(copy, digest)` of a shape as the kernel takes it in a load.

        The copy is a shape of our own, which the caller's later `move` does
        not reach, for `_solve`; the digest is written now, or not at all while
        the cache is off.
        """
        copy = shape.Moved(TopLoc_Location())
        return copy, None if _connection is None else _digest(copy)

    class CachedDistShapeShape(base):
        def __init__(self, *args, **kwargs):
            super().__init__()
            # `(copy, digest)` of each loaded shape, from `taken`.
            self._loaded1 = self._loaded2 = None
            self._flag = Extrema_ExtFlag_MINMAX
            self._algo = Extrema_ExtAlgo_Grad
            self._deflection = None
            self._multithread = False
            # `(value, state)` while the last Perform was answered by the cache.
            self._hit = None
            if args or kwargs:
                self._construct(*args, **kwargs)

        def _construct(self, Shape1, Shape2, *rest, theDeflection=None,
                       F=None, A=None, theRange=None):
            # The two-shape overloads compute at once, as the kernel's do; a
            # number in third place is the deflection overload.
            if rest and isinstance(rest[0], (int, float)):
                theDeflection, rest = rest[0], rest[1:]
            given = dict(zip(("F", "A", "theRange"), rest))
            F = given.get("F", F)
            A = given.get("A", A)
            theRange = given.get("theRange", theRange)
            self.LoadS1(Shape1)
            self.LoadS2(Shape2)
            if theDeflection is not None:
                self.SetDeflection(theDeflection)
            if F is not None:
                self.SetFlag(F)
            if A is not None:
                self.SetAlgo(A)
            self.Perform(*(() if theRange is None else (theRange,)))

        def LoadS1(self, Shape1):
            super().LoadS1(Shape1)
            self._loaded1 = taken(Shape1)

        def LoadS2(self, Shape1):
            super().LoadS2(Shape1)
            self._loaded2 = taken(Shape1)

        def SetFlag(self, F):
            super().SetFlag(F)
            self._flag = F

        def SetAlgo(self, A):
            super().SetAlgo(A)
            self._algo = A

        def SetDeflection(self, theDeflection):
            super().SetDeflection(theDeflection)
            self._deflection = theDeflection

        def SetMultiThread(self, theIsMultiThread):
            super().SetMultiThread(theIsMultiThread)
            self._multithread = theIsMultiThread

        def Perform(self, *args):
            global _hits, _total
            _total += 1
            state = self._state()
            key = None if _connection is None else _key(state)
            value = None if key is None else _lookup(key)
            if value is not None:
                _hits += 1
                self._hit = (value, state)
                return True
            self._hit = None
            done = super().Perform(*args)
            if key is not None and super().IsDone():
                _store(key, super().Value())
            return done

        def IsDone(self):
            return self._hit is not None or super().IsDone()

        def Value(self):
            return self._hit[0] if self._hit is not None else super().Value()

        def _solve(self):
            """Give the kernel the solution a cached answer stands for."""
            if self._hit is None:
                return
            (_value, answered), self._hit = self._hit, None
            current = self._state()
            self._load(answered)
            base.Perform(self)
            self._load(current)

        def _state(self):
            return (self._loaded1, self._loaded2, self._flag, self._algo,
                    self._deflection, self._multithread)

        def _load(self, state):
            # The kernel's setters only: the recorded state stays the current one.
            loaded1, loaded2, flag, algo, deflection, multithread = state
            base.LoadS1(self, loaded1[0])
            base.LoadS2(self, loaded2[0])
            base.SetFlag(self, flag)
            base.SetAlgo(self, algo)
            base.SetDeflection(self, Precision.Confusion_s()
                               if deflection is None else deflection)
            base.SetMultiThread(self, multithread)

    def solving(name):
        def accessor(self, *args):
            self._solve()
            return getattr(base, name)(self, *args)
        accessor.__name__ = name
        return accessor

    for name in _SOLUTION:
        setattr(CachedDistShapeShape, name, solving(name))
    return CachedDistShapeShape
