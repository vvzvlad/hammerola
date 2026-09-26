"""Stand-ins for the CadQuery objects the build reads.

The gates never call a kernel: they read bounding boxes, ask a Location for its
rotation matrix, and intersect two solids. All of that is an interface, and the
interface is what these implement -- so the gate logic is tested on a python
with no OCP in it, which is the python CI has and the python most laptops have.

`isValid` is present because that is the attribute `as_shapes` uses to decide
whether it was handed geometry at all; nothing calls it.

WHAT THE FAKE BOOLEAN DOES is worth being exact about, because a fake that
answers the same as OCC for the wrong reason teaches nothing: `Shape.intersect`
here returns the volume of the two boxes' overlap. That is the true answer for
axis-aligned boxes, which is all these tests use, and it reproduces the two
properties the gate depends on -- disjoint gives 0, and merely touching gives 0
as well, because one of the three overlaps is exactly zero.
"""

import math


# The rotation matrix of a Location that turns nothing.
IDENTITY = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


class Box:
    """What Shape.BoundingBox() returns, as far as the layout gate is concerned."""

    def __init__(self, xmin, ymin, zmin, xmax, ymax, zmax):
        self.xmin, self.ymin, self.zmin = xmin, ymin, zmin
        self.xmax, self.ymax, self.zmax = xmax, ymax, zmax
        self.xlen = xmax - xmin
        self.ylen = ymax - ymin
        self.zlen = zmax - zmin

    def moved(self, dx, dy, dz):
        return Box(self.xmin + dx, self.ymin + dy, self.zmin + dz,
                   self.xmax + dx, self.ymax + dy, self.zmax + dz)


class Face:
    def __init__(self, area):
        self._area = area

    def Area(self):
        return self._area


class Shape:
    """One solid: a box, a volume and some face areas.

    `solids` is what `Solids()` hands back, and it defaults to "this shape,
    which is one solid" -- that is what OCC answers for a solid, and it is what
    makes the fake boolean below readable the way the gate reads a real one. A
    shape standing in for the OPEN SHELL a tangential boolean can return passes
    `solids=()`: it has a Volume() -- OCC gives one for the closed body it
    completes a shell into -- and no solid in it at all.
    """

    def __init__(self, box=None, volume=1.0, areas=(6.0, 5.0, 4.0), solids=None):
        self._box = box or Box(0, 0, 0, 1, 1, 1)
        self._volume = volume
        self._areas = tuple(areas)
        self._solids = solids

    def isValid(self):
        return True

    def BoundingBox(self):
        return self._box

    def Volume(self):
        return self._volume

    def Solids(self):
        return [self] if self._solids is None else list(self._solids)

    def Faces(self):
        return [Face(a) for a in self._areas]

    def moved(self, at):
        """A copy standing where the Location puts it, as Shape.moved() is.

        `type(self)` AND EVERY FIELD, because a fake that stops being itself
        when it is placed is the green lie this module exists to avoid: hard
        `Shape(...)` made `Broken(...).moved(at)` an ordinary solid that
        intersects perfectly, and dropped the `solids=()` that is the whole of
        what a `Shell` stands for. Nothing in a view has to carry an `at` for
        that to be wrong -- it only has to be the day one does.
        """
        return type(self)(self._box.moved(at.dx, at.dy, at.dz),
                          volume=self._volume, areas=self._areas,
                          solids=self._solids)

    def intersect(self, other):
        """The shared solid, as a box overlap. See the module docstring."""
        mine, theirs = self._box, other.BoundingBox()
        overlap = [max(0.0, min(mine.xmax, theirs.xmax) - max(mine.xmin, theirs.xmin)),
                   max(0.0, min(mine.ymax, theirs.ymax) - max(mine.ymin, theirs.ymin)),
                   max(0.0, min(mine.zmax, theirs.zmax) - max(mine.zmin, theirs.zmin))]
        return Shape(volume=overlap[0] * overlap[1] * overlap[2])


class Workplane:
    """What a model hands over: a stack of one or more bodies."""

    def __init__(self, *shapes):
        self._shapes = list(shapes)

    def val(self):
        return self._shapes[0]

    def vals(self):
        return list(self._shapes)

    def newObject(self, shapes):
        return Workplane(*shapes)


class Location:
    """cq.Location as far as this build reads one.

    Two things are asked of it and both are here: the rotation matrix, read off
    `wrapped.Transformation().Value(row, col)` by the print gate, and the shift,
    applied by `Shape.moved`. The real class carries the shift in the same
    matrix; keeping it beside is what lets these fakes stay three lines long.
    """

    def __init__(self, dx=0.0, dy=0.0, dz=0.0, rows=IDENTITY):
        self.dx, self.dy, self.dz = dx, dy, dz
        self.rows = rows
        self.wrapped = _Wrapped(rows)

    def __repr__(self):
        return f"Location({self.dx}, {self.dy}, {self.dz})"


class _Wrapped:
    def __init__(self, rows):
        self._rows = rows

    def Transformation(self):
        return _Trsf(self._rows)


class _Trsf:
    def __init__(self, rows):
        self._rows = rows

    def Value(self, row, col):
        # OCC indexes from 1, and the gate reads it that way.
        return self._rows[row - 1][col - 1]

    def IsNegative(self):
        """Does the vectorial part have a negative determinant? -- gp_Trsf's own.

        COMPUTED FROM THE MATRIX rather than stored beside it, which is what
        keeps the fake from drifting away from OCC: gp_Trsf answers this off the
        sign of the same determinant, so whatever rows a test writes get the
        verdict a real gp_Trsf built from them would give. A flag set by hand
        could say "a rotation" about a reflection and the gate would pass a test
        it fails in production.
        """
        (a, b, c), (d, e, f), (g, h, i) = self._rows
        det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
        return det < 0.0


def turned(degrees, axis="z"):
    """A Location that turns about one axis. `axis="z"` is the legal one."""
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    rows = {
        "x": ((1.0, 0.0, 0.0), (0.0, c, -s), (0.0, s, c)),
        "y": ((c, 0.0, s), (0.0, 1.0, 0.0), (-s, 0.0, c)),
        "z": ((c, -s, 0.0), (s, c, 0.0), (0.0, 0.0, 1.0)),
    }[axis]
    return Location(rows=rows)


def mirrored(axis="x"):
    """A Location that REFLECTS -- `gp_Trsf.SetMirror(gp_Ax2(origin, axis))`.

    The matrices are transcribed from a real gp_Trsf (cadquery 2.8.0): a mirror
    in the plane normal to X is diag(-1, 1, 1), normal to Y is diag(1, -1, 1).
    Both leave Z exactly where it was -- the third row and the third column read
    (0, 0, 1) -- which is why the print gate needed the determinant to tell them
    from a turn. `z` is the third one for completeness: it moves Z and would be
    caught by the rows alone.
    """
    rows = {
        "x": ((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
        "y": ((1.0, 0.0, 0.0), (0.0, -1.0, 0.0), (0.0, 0.0, 1.0)),
        "z": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, -1.0)),
    }[axis]
    return Location(rows=rows)


def part(x=0.0, y=0.0, size=10.0, volume=1000.0, areas=(100.0, 100.0, 50.0)):
    """One printable-shaped object standing at (x, y) on the plate."""
    return Workplane(Shape(Box(x, y, 0, x + size, y + size, size),
                           volume=volume, areas=areas))


class Mesh:
    """A trimesh.Trimesh as far as this build reads one: three arrays and a box.

    `parts.MESH_ATTRS` is the list, and this implements exactly it -- so a test
    that builds a scene out of these is testing the same interface a real
    Trimesh presents, on a python with no trimesh installed at all. That a REAL
    one presents it is pinned separately, by the tests that load one.

    The default is a unit tetrahedron, which is the smallest thing with a
    volume: four vertices, four faces, and a box that is not a point.
    """

    def __init__(self, vertices=None, faces=None, normals=None):
        self.vertices = vertices if vertices is not None else [
            [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        self.faces = faces if faces is not None else [
            [0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]
        self.vertex_normals = normals if normals is not None else [
            [0.0, 0.0, -1.0]] * len(self.vertices)

    @property
    def bounds(self):
        """`[[xmin, ymin, zmin], [xmax, ymax, zmax]]`, trimesh's own shape."""
        columns = list(zip(*self.vertices))
        return [[min(values) for values in columns],
                [max(values) for values in columns]]


def catalogue(**kinds):
    """A read catalogue: `catalogue(lid="printable", screw="hardware")`.

    Every entry gets a part of its own standing at the origin. Where a test
    cares where a part stands it passes the object instead of the kind:
    `catalogue(lid=("printable", part(x=50)))`. A `Mesh` passed that way lands
    under `mesh` rather than under `shape`, which is where `read_catalogue` puts
    one -- `catalogue(scan=("mock", Mesh()))`.
    """
    read = {}
    for key, value in kinds.items():
        kind, obj = value if isinstance(value, tuple) else (value, part())
        mesh = obj if isinstance(obj, Mesh) else None
        read[key] = {"shape": None if mesh is not None else obj, "mesh": mesh,
                     "kind": kind, "color": None, "note": None}
    return read


def node(key, obj=None, alpha=1.0, at=None, color="#000000", deformed=None,
         label=None):
    """One leaf, in the shape prepare_views produces.

    A `Mesh` handed over as `obj` makes a MESH leaf, whose `shape` is None --
    exactly one of the two is set on every leaf `_read_reference` builds.
    """
    mesh = obj if isinstance(obj, Mesh) else None
    return {
        "key": key,
        "shape": None if mesh is not None else (obj if obj is not None
                                                else part()),
        "mesh": mesh,
        "color": color,
        "alpha": alpha,
        "at": at,
        "deformed": deformed,
        "label": label or repr(key),
    }


def view(vid, nodes, nested_ok=frozenset(), interference_ok=None, tree=None):
    """A view in the shape prepare_views hands to the gates."""
    nodes = list(nodes)
    return {
        "id": vid,
        "label": vid,
        "file": f"{vid}.json",
        "nested_ok": nested_ok,
        "interference_ok": dict(interference_ok or {}),
        "tree": list(range(len(nodes))) if tree is None else tree,
        "nodes": nodes,
    }
