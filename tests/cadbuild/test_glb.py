"""`Hub.glb`: a view of the catalogue as the GLB a page outside the hub loads.

It runs the build's own reading and tessellation, so it needs the CAD kernel and
skips where it does not import; CI's test image carries it. `Hub.compress` needs
Node.js, which only the hub's image has: check (k) in ci/smoke.py runs it there.
"""

import json
import struct
from types import SimpleNamespace

import pytest

from src.cadbuild.parts import read_catalogue
from src.cadbuild.publish import Hub
from src.cadbuild.views import export_views, prepare_views


def _gltf(glb):
    """The GLB's JSON document, once the header and both chunk headers check out."""
    magic, version, length = struct.unpack_from("<III", glb)
    assert (magic, version, length) == (0x46546C67, 2, len(glb))
    size, kind = struct.unpack_from("<II", glb, 12)
    assert kind == 0x4E4F534A
    gltf = json.loads(glb[20:20 + size])
    blob, kind = struct.unpack_from("<II", glb, 20 + size)
    assert kind == 0x004E4942
    assert blob == gltf["buffers"][0]["byteLength"] == len(glb) - 28 - size
    return gltf


def test_a_view_is_its_tree_in_metres_with_the_triangles_the_viewer_gets(out_dir):
    """A group, an `at`, a mesh leaf at alpha 0.5, and a view id that is not `assembled`.

    The triangles are counted against the document a build writes for the same
    view, so nothing is dropped or doubled between the two.
    """
    cq = pytest.importorskip("cadquery", exc_type=ImportError,
                             reason="a real tessellation needs the CAD kernel")
    pytest.importorskip("ocp_tessellate", exc_type=ImportError,
                        reason="a real tessellation needs the tessellator")
    trimesh = pytest.importorskip("trimesh")

    parts = {
        "lid": {"shape": cq.Workplane("XY").box(10, 10, 2), "kind": "printable"},
        "pin": {"shape": cq.Workplane("XY").cylinder(8, 1.5),
                "kind": "printable"},
        "scan": {"mesh": trimesh.creation.box(extents=(4, 4, 4)),
                 "kind": "mock"},
    }
    view = {"id": "site", "parts": [
        {"group": "housing", "parts": [
            "lid", {"part": "pin", "at": cq.Location(cq.Vector(10, 20, 30))}]},
        {"part": "scan", "alpha": 0.5},
    ]}

    gltf = _gltf(Hub().glb(view, parts))

    nodes = gltf["nodes"]
    named = {node["name"]: node for node in nodes}
    root = gltf["scenes"][0]["nodes"]
    assert [nodes[index]["name"] for index in root] == ["root"]
    assert named["root"]["rotation"] == pytest.approx(
        [-0.5 ** 0.5, 0.0, 0.0, 0.5 ** 0.5])
    (document,) = named["root"]["children"]
    assert [nodes[index]["name"] for index in nodes[document]["children"]] == \
        ["housing", "scan"]
    assert [nodes[index]["name"] for index in named["housing"]["children"]] == \
        ["lid", "pin"]
    assert named["pin"]["translation"] == pytest.approx([0.01, 0.02, 0.03])
    assert "translation" not in named["lid"]

    def primitive(name):
        return gltf["meshes"][named[name]["mesh"]]["primitives"][0]

    # The 10 x 10 x 2 mm lid, centred on the origin: its corners, in metres.
    lid = gltf["accessors"][primitive("lid")["attributes"]["POSITION"]]
    assert lid["max"] == pytest.approx([0.005, 0.005, 0.001])
    assert lid["min"] == pytest.approx([-0.005, -0.005, -0.001])

    materials = gltf["materials"]
    assert materials[primitive("scan")["material"]]["alphaMode"] == "BLEND"
    assert materials[primitive("scan")["material"]][
        "pbrMetallicRoughness"]["baseColorFactor"][3] == 0.5
    assert "alphaMode" not in materials[primitive("lid")["material"]]
    assert all(material["doubleSided"] for material in materials)

    catalogue = read_catalogue(SimpleNamespace(parts=lambda: parts))
    (entry,) = export_views(prepare_views([{**view, "id": "assembled"}],
                                          catalogue), out_dir)
    tree = json.loads((out_dir / entry["file"]).read_text(encoding="utf-8"))

    def leaves(node):
        if "shape" in node:
            return [node]
        return [leaf for part in node["parts"] for leaf in leaves(part)]

    drawn = {leaf["name"]: len(leaf["shape"]["triangles"]) // 3
             for leaf in leaves(tree)}
    written = {name: gltf["accessors"][primitive(name)["indices"]]["count"] // 3
               for name in drawn}
    assert written == drawn
    assert drawn["scan"] == 12
