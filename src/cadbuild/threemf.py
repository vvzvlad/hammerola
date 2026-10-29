#!/usr/bin/env python3
"""A 3MF package of several objects, each placed on the bed by a build item.

Our own writer, on the standard library alone (`zipfile` for the package,
ElementTree for the XML): trimesh's 3MF exporter needs lxml, which the image
does not carry, and cadquery's `ThreeMFWriter` wraps every mesh into one
component object under one build item, which a slicer loads as one part.

The same input gives the same bytes: nothing in the XML carries a date, and
every member of the zip carries one fixed timestamp.
"""

import xml.etree.ElementTree as ET
import zipfile

# The 3MF Core Specification's names for the three parts of a package.
CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
CONTENT_TYPES_NAMESPACE = \
    "http://schemas.openxmlformats.org/package/2006/content-types"
RELATIONSHIPS_NAMESPACE = \
    "http://schemas.openxmlformats.org/package/2006/relationships"
MODEL_RELATIONSHIP = \
    "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
MODEL_PATH = "3D/3dmodel.model"

# The earliest moment a zip member can be stamped with, for every member.
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def write_3mf(path, objects, items):
    """Write `path` as a 3MF package.

    `objects` maps a name to `(vertices, faces)`: an N x 3 sequence of
    coordinates in millimetres and an M x 3 sequence of indices into them. Each
    becomes one `<object>`, numbered from 1 in the mapping's order.

    `items` is `[(name, matrix)]`, one `<item>` of the build each, in order: the
    object it places and a 4 x 4 matrix `[R | t]` acting on a COLUMN vector.
    Several items may name one object, and a slicer loads those as instances
    of one part.
    """
    with zipfile.ZipFile(path, "w") as package:
        _write_xml(package, "[Content_Types].xml", _content_types())
        _write_xml(package, "_rels/.rels", _relationships())
        _write_xml(package, MODEL_PATH, _model(objects, items))


def _content_types():
    types = ET.Element("Types", {"xmlns": CONTENT_TYPES_NAMESPACE})
    ET.SubElement(types, "Default", {
        "Extension": "rels",
        "ContentType":
            "application/vnd.openxmlformats-package.relationships+xml"})
    ET.SubElement(types, "Default", {
        "Extension": "model",
        "ContentType":
            "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"})
    return types


def _relationships():
    relationships = ET.Element("Relationships",
                               {"xmlns": RELATIONSHIPS_NAMESPACE})
    ET.SubElement(relationships, "Relationship", {
        "Target": f"/{MODEL_PATH}", "Id": "rel0", "Type": MODEL_RELATIONSHIP})
    return relationships


def _model(objects, items):
    # `xmlns` and `xml:lang` as plain attributes rather than through
    # `ET.register_namespace`, which would change a registry every other user
    # of ElementTree in the process shares.
    model = ET.Element("model", {"unit": "millimeter", "xml:lang": "en-US",
                                 "xmlns": CORE_NAMESPACE})
    resources = ET.SubElement(model, "resources")
    ids = {}
    for number, (name, (vertices, faces)) in enumerate(objects.items(), 1):
        ids[name] = str(number)
        mesh = ET.SubElement(
            ET.SubElement(resources, "object",
                          {"id": ids[name], "name": name, "type": "model"}),
            "mesh")
        listed = ET.SubElement(mesh, "vertices")
        for x, y, z in vertices:
            ET.SubElement(listed, "vertex", {"x": _number(x), "y": _number(y),
                                             "z": _number(z)})
        triangles = ET.SubElement(mesh, "triangles")
        for a, b, c in faces:
            ET.SubElement(triangles, "triangle", {"v1": str(int(a)),
                                                  "v2": str(int(b)),
                                                  "v3": str(int(c))})
    build = ET.SubElement(model, "build")
    for name, matrix in items:
        ET.SubElement(build, "item", {"objectid": ids[name],
                                      "transform": _transform(matrix)})
    return model


def _transform(matrix):
    """The 12 numbers of a build item's `transform`, from a column-vector matrix.

    3MF multiplies a ROW vector by its matrix, so the attribute is the
    transpose of the upper 3 x 4 block read row by row -- R00 R10 R20, R01 R11
    R21, R02 R12 R22, then tx ty tz -- which is what trimesh writes too
    (`matrix[:3, :4].T.flatten()`).
    """
    return " ".join(_number(matrix[row][column])
                    for column in range(4) for row in range(3))


def _number(value):
    """A coordinate as text that reads back as the same float.

    Through `float` first: numpy 2 spells `repr` of its own scalar as
    `np.float64(...)`.
    """
    return repr(float(value))


def _write_xml(package, name, root):
    """One member of the package: the tree, serialised straight into the zip
    member without a second whole copy of it as bytes."""
    member = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
    member.compress_type = zipfile.ZIP_DEFLATED
    with package.open(member, "w") as stream:
        ET.ElementTree(root).write(stream, encoding="utf-8",
                                   xml_declaration=True)
