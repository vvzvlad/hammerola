"""The 3MF of a bed: what `threemf.write_3mf` writes, and what
`assembly.export_plate_3mfs` hands it.

Read back with the standard library, the way a slicer reads the file: the model
part out of the zip, every object and build item out of the XML, and a point
placed by an item's `transform` under the 3MF rule, a ROW vector times the
matrix. A writer that put the matrix down untransposed passes every count and
turns a part the wrong way, so the turn is asserted as a point that moves.

The writer needs no kernel. The last test does -- a real `cq.Location` turn,
read off its `gp_Trsf` as the build reads it -- and skips without one; CI's
test image carries it.
"""

import xml.etree.ElementTree as ET
import zipfile

import pytest

from src.cadbuild.artifacts import PRINT_VIEW_ID
from src.cadbuild.assembly import export_plate_3mfs
from src.cadbuild.threemf import CORE_NAMESPACE, MODEL_PATH, write_3mf

from fakes import node, view

NS = {"m": CORE_NAMESPACE}

# A tetrahedron, one corner of it at a coordinate whose shortest spelling is
# long: a writer that rounded would not give it back.
CORNERS = [(0.0, 0.0, 0.1 + 0.2), (10.0, 0.0, 0.0), (0.0, 10.0, 0.0),
           (0.0, 0.0, 10.0)]
FACES = [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)]


def shift(x=0.0, y=0.0, z=0.0):
    return [[1.0, 0.0, 0.0, x], [0.0, 1.0, 0.0, y], [0.0, 0.0, 1.0, z],
            [0.0, 0.0, 0.0, 1.0]]


def read_model(path):
    with zipfile.ZipFile(path) as package:
        return ET.fromstring(package.read(MODEL_PATH))


def objects_of(model):
    return model.findall("m:resources/m:object", NS)


def items_of(model):
    return model.findall("m:build/m:item", NS)


def vertices_of(obj):
    return [tuple(float(vertex.get(axis)) for axis in "xyz")
            for vertex in obj.findall("m:mesh/m:vertices/m:vertex", NS)]


def placed(item, point):
    """`point` where a build item puts it: `[x y z 1]` times the 4 x 3 matrix
    whose rows are the attribute's numbers three at a time."""
    m = [float(number) for number in item.get("transform").split()]
    x, y, z = point
    return tuple(x * m[c] + y * m[3 + c] + z * m[6 + c] + m[9 + c]
                 for c in range(3))


def test_one_object_per_name_and_one_item_per_placement(tmp_path):
    """Two references to `pin` are ONE object placed twice, which a slicer
    loads as two instances of one part; the geometry comes back exactly."""
    path = tmp_path / "bed.3mf"
    write_3mf(path, {"pin": (CORNERS, FACES), "lid": (CORNERS, FACES[:2])},
              [("pin", shift()), ("lid", shift(x=30.0)), ("pin", shift(y=30.0))])

    with zipfile.ZipFile(path) as package:
        assert sorted(package.namelist()) == sorted(
            ["[Content_Types].xml", "_rels/.rels", MODEL_PATH])
    model = read_model(path)
    assert model.get("unit") == "millimeter"
    objects = objects_of(model)
    assert [(obj.get("id"), obj.get("name"), obj.get("type"))
            for obj in objects] == [("1", "pin", "model"), ("2", "lid", "model")]
    assert [item.get("objectid") for item in items_of(model)] == ["1", "2", "1"]
    assert vertices_of(objects[0]) == CORNERS
    assert [tuple(int(triangle.get(v)) for v in ("v1", "v2", "v3"))
            for triangle in objects[0].findall(
                "m:mesh/m:triangles/m:triangle", NS)] == FACES


def test_a_quarter_turn_moves_x_onto_y(tmp_path):
    """A column-vector matrix turning X onto Y, then shifting 5 along X: the
    point (1, 0, 0) has to land on (5, 1, 0). Written untransposed it lands on
    (5, -1, 0), the turn the other way."""
    quarter = [[0.0, -1.0, 0.0, 5.0], [1.0, 0.0, 0.0, 0.0],
               [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
    path = tmp_path / "bed.3mf"
    write_3mf(path, {"pin": (CORNERS, FACES)}, [("pin", quarter)])

    (item,) = items_of(read_model(path))
    assert placed(item, (1.0, 0.0, 0.0)) == (5.0, 1.0, 0.0)


def test_each_bed_is_a_file_of_its_own_with_every_part_on_z_zero(tmp_path):
    """Two beds: two files, and in each only the references on that bed.

    The pin's mesh reaches 3 mm below its origin and the lid's starts 4 mm
    above it, and the turned pin's `at` lifts it by 7 mm: every item still
    stands on z = 0, because the lift is the lowest point of its key's mesh,
    not the height the view gave. X and Y are the view's, turn included: the
    pin spans x 1..5 in its own frame, so a quarter turn about Z puts it at
    y 1..5 round x = 20, and the turn the other way at y -5..-1.
    """
    cq = pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so there "
               "is no real Location to read a turn out of")
    import trimesh

    pin = trimesh.creation.box(extents=(4.0, 2.0, 6.0))
    pin.apply_translation((3.0, 0.0, 0.0))
    pin.export(str(tmp_path / "pin.stl"))
    lid = trimesh.creation.box(extents=(10.0, 10.0, 2.0))
    lid.apply_translation((0.0, 0.0, 5.0))
    lid.export(str(tmp_path / "lid.stl"))
    turned = cq.Location(cq.Vector(20.0, 0.0, 7.0), cq.Vector(0.0, 0.0, 1.0), 90)
    prepared = [view(PRINT_VIEW_ID, [
        node("pin", at=turned), node("pin"),
        node("lid", at=cq.Location(cq.Vector(300.0, 0.0, 0.0)), plate=2)])]

    written = export_plate_3mfs(prepared, tmp_path)

    assert written == {"1": f"{PRINT_VIEW_ID}.3mf", "2": f"{PRINT_VIEW_ID}-2.3mf"}
    first = read_model(tmp_path / written["1"])
    second = read_model(tmp_path / written["2"])
    assert [obj.get("name") for obj in objects_of(first)] == ["pin"]
    assert [item.get("objectid") for item in items_of(first)] == ["1", "1"]
    assert [obj.get("name") for obj in objects_of(second)] == ["lid"]
    assert len(items_of(second)) == 1

    for model in (first, second):
        corners = vertices_of(objects_of(model)[0])
        for item in items_of(model):
            moved = [placed(item, corner) for corner in corners]
            assert min(z for _x, _y, z in moved) == pytest.approx(0.0, abs=1e-9)

    turned_pin = [placed(items_of(first)[0], corner)
                  for corner in vertices_of(objects_of(first)[0])]
    assert min(x for x, _y, _z in turned_pin) == pytest.approx(19.0)
    assert max(x for x, _y, _z in turned_pin) == pytest.approx(21.0)
    assert min(y for _x, y, _z in turned_pin) == pytest.approx(1.0)
    assert max(y for _x, y, _z in turned_pin) == pytest.approx(5.0)
    lid_on_two = [placed(items_of(second)[0], corner)
                  for corner in vertices_of(objects_of(second)[0])]
    assert min(x for x, _y, _z in lid_on_two) == pytest.approx(295.0)
