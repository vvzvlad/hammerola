"""Stand-ins for the CadQuery objects the gates read.

The gates never call a kernel: `check_print_layout` reads bounding boxes,
`_match_solids` reads volumes and face areas, and `as_shapes` walks `vals()`.
All of that is an interface, and the interface is what these implement -- so
the gate logic is tested on a python with no OCP in it, which is the python CI
has and the python most laptops have.

`isValid` is present because that is the attribute `as_shapes` uses to decide
whether it was handed geometry at all; nothing calls it.
"""


class Box:
    """What Shape.BoundingBox() returns, as far as the layout gate is concerned."""

    def __init__(self, xmin, ymin, zmin, xmax, ymax, zmax):
        self.xmin, self.ymin, self.zmin = xmin, ymin, zmin
        self.xmax, self.ymax, self.zmax = xmax, ymax, zmax
        self.xlen = xmax - xmin
        self.ylen = ymax - ymin
        self.zlen = zmax - zmin


class Face:
    def __init__(self, area):
        self._area = area

    def Area(self):
        return self._area


class Shape:
    """One solid: a box, a volume and some face areas."""

    def __init__(self, box=None, volume=1.0, areas=(6.0, 5.0, 4.0)):
        self._box = box or Box(0, 0, 0, 1, 1, 1)
        self._volume = volume
        self._areas = tuple(areas)

    def isValid(self):
        return True

    def BoundingBox(self):
        return self._box

    def Volume(self):
        return self._volume

    def Faces(self):
        return [Face(a) for a in self._areas]


class Workplane:
    """What a model hands over: a stack of one or more bodies."""

    def __init__(self, *shapes):
        self._shapes = list(shapes)

    def val(self):
        return self._shapes[0]

    def vals(self):
        return list(self._shapes)


def part(x=0.0, y=0.0, size=10.0, volume=1000.0, areas=(100.0, 100.0, 50.0)):
    """One printable-shaped object standing at (x, y) on the plate."""
    return Workplane(Shape(Box(x, y, 0, x + size, y + size, size),
                           volume=volume, areas=areas))


def view(vid, objects, names, nested_ok=frozenset()):
    """A view in the shape prepare_views hands to the gates."""
    return {
        "id": vid,
        "label": vid,
        "objects": list(objects),
        "names": list(names),
        "colors": ["#000000"] * len(objects),
        "alphas": [1.0] * len(objects),
        "nested_ok": nested_ok,
    }
