#!/usr/bin/env python3
"""What model.py's `published(hub)` is handed: a view as a GLB, and the GLB made small.

`Hub()` is that object, and its two helpers are for a project that puts its
model somewhere outside the hub, such as a website. Neither keeps anything:
each works in a temporary directory and hands back bytes, and where those go
is the project's code.

  * `glb(view, parts)` -- one view, read and tessellated by the build's own
    code (`build.build`), written out as a binary glTF.
  * `compress(glb, simplify_error=0.001, flatten=True)` -- gltf-transform's
    `optimize` with Draco, the Node.js tool the Dockerfile's `gltf` stage
    installs; `flatten=False` keeps the view's groups as named nodes.

No module-level import of the CAD kernel or numpy, as in the rest of the
package (src/cadbuild/__init__.py).
"""

import json
from pathlib import Path
import struct
import subprocess
import tempfile
from types import SimpleNamespace

from .artifacts import ASSEMBLED_VIEW_ID
from .errors import BuildError
from .parts import read_catalogue
from .views import export_views, prepare_views


# Node.js and gltf-transform's command line, where the Dockerfile's `gltf`
# stage puts them. By absolute path: a build resolves no command by name (its
# PATH is fixed, `runner.child_environment`), and nothing else runs node.
NODE = "/opt/gltf/node"
GLTF_TRANSFORM = "/opt/gltf/node_modules/@gltf-transform/cli/bin/cli.js"

# What keeps node inside a build's RLIMIT_AS of 6 GiB (`limits.DEFAULT_LIMITS`).
# V8 reserves address space for every WebAssembly memory up front, guard
# regions by default and the memory's whole maximum without them, and
# gltf-transform starts about nine (Draco, meshoptimizer, mikktspace...): 96 GB
# reserved, measured. So bounds checks instead of guard regions, and each memory
# capped at 384 MiB: the largest board measured (1.2 million triangles, a 41 MB
# GLB) needs 160-192 MiB in the simplifier, and with twice that per memory the
# process peaks at 5.3 GB of address space.
NODE_FLAGS = ("--disable-wasm-trap-handler", "--wasm-max-mem-pages=6144")

# What `optimize` is told after its two paths: Draco and no texture pass (a
# view has none); then the simplification's error, `compress`'s argument.
OPTIMIZE_OPTIONS = ("--compress", "draco", "--texture-compress", "false")

# The simplification's error by default, as a share of the mesh's extent.
# Measured on four real boards with their copper left out: 0.06-0.59 MB, and at
# most 0.45 % of a frame's pixels differ from the uncompressed GLB. Text drawn
# as geometry, a sticker's, falls apart at it: on the WB-MSW v.4 sensor (an
# 86 mm case) it keeps its letters at 0.0001, 0.43 MB against 0.23 MB.
SIMPLIFY_ERROR = 0.001

# A view is drawn in millimetres, and glTF is in metres.
METRES_PER_MM = 0.001

# The root node's rotation: a quarter turn about X, standing the CAD's Z-up on
# glTF's Y-up. Written [x, y, z, w], as glTF and the view document both write
# a quaternion.
Z_UP_TO_Y_UP = [-0.7071067811865476, 0.0, 0.0, 0.7071067811865476]
IDENTITY_TURN = [0.0, 0.0, 0.0, 1.0]

# The numbers of the glTF 2.0 binary container and of its accessors.
GLB_MAGIC = 0x46546C67
GLB_VERSION = 2
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125
# The largest value of each index type is reserved (glTF 2.0, 3.7.2.1), so a
# mesh with this many vertices or more needs 32-bit indices.
UNSIGNED_SHORT_RESERVED = 0xFFFF


class Hub:
    """The helpers `published(hub)` is called with."""

    def glb(self, view, parts):
        """One view of the catalogue `parts`, as the bytes of a GLB.

        `view` is one entry as views() returns it and `parts` the dict
        parts() returns; the build's own code reads both, so whatever a build
        refuses is refused here with the build's message. The view is read as
        the `assembled` one whatever its id says: `prepare_views` refuses a
        list without that view, and a GLB has nowhere to carry an id.
        """
        catalogue = read_catalogue(SimpleNamespace(parts=lambda: parts))
        prepared = prepare_views([{**view, "id": ASSEMBLED_VIEW_ID}], catalogue)
        with tempfile.TemporaryDirectory() as scratch:
            (entry,) = export_views(prepared, Path(scratch))
            document = json.loads(
                (Path(scratch) / entry["file"]).read_text(encoding="utf-8"))
        return document_glb(document)

    def compress(self, glb, simplify_error=SIMPLIFY_ERROR, flatten=True):
        """The bytes of a GLB through `gltf-transform optimize` (OPTIMIZE_OPTIONS),
        simplified within `simplify_error` of the mesh's extent.

        `optimize` flattens the node tree and joins its meshes, one a material
        for the whole model. `flatten=False` keeps the view's groups as nodes of
        their own, with their names, and joins only the meshes of one group:
        a page that hides or shows a group finds it by its name."""
        with tempfile.TemporaryDirectory() as scratch:
            source = Path(scratch) / "in.glb"
            target = Path(scratch) / "out.glb"
            source.write_bytes(glb)
            run = subprocess.run(
                [NODE, *NODE_FLAGS, GLTF_TRANSFORM, "optimize", str(source),
                 str(target), *OPTIMIZE_OPTIONS,
                 "--simplify-error", str(simplify_error),
                 *(() if flatten else ("--flatten", "false"))],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                errors="replace")
            if run.returncode != 0:
                raise BuildError(
                    f"gltf-transform optimize exited {run.returncode}:\n"
                    f"{run.stdout.strip()}")
            return target.read_bytes()


def document_glb(document):
    """A view document, as `export_views` writes it, as the bytes of a GLB.

    The document's tree is the node tree, with the names the viewer's tree
    shows: a group is a node with its `loc` and children, a leaf a node with
    its `loc` and one mesh, and three.js composes them as the viewer does. One
    material per colour and alpha, double-sided as the viewer draws every part,
    and blended under alpha 1, as the viewer blends it.

    Millimetres become metres in the vertices and translations themselves, so
    the root above the document only turns Z-up into Y-up. A leaf without
    triangles (a wire or a point, drawn as lines) has nothing to put in a mesh
    and is left out. What the build adds for the viewer and the hub (`key`,
    `at`, `edges`, `joint`, `bb` and the rest) is not read.
    """
    import numpy as np

    blob = bytearray()
    buffer_views, accessors, meshes, nodes, materials = [], [], [], [], []
    material_of = {}

    def accessor(array, target, component, kind, **bounds):
        # Every view starts on a four-byte boundary, as floats and uint32 need.
        blob.extend(bytes(-len(blob) % 4))
        buffer_views.append({"buffer": 0, "byteOffset": len(blob),
                             "byteLength": array.nbytes, "target": target})
        blob.extend(array.tobytes())
        accessors.append({"bufferView": len(buffer_views) - 1,
                          "componentType": component, "count": len(array),
                          "type": kind, **bounds})
        return len(accessors) - 1

    def material(color, alpha):
        if (color, alpha) not in material_of:
            entry = {"name": color, "doubleSided": True,
                     "pbrMetallicRoughness": {
                         "baseColorFactor": [_linear(int(color[i:i + 2], 16))
                                             for i in (1, 3, 5)] + [alpha],
                         "metallicFactor": 0.0, "roughnessFactor": 0.6}}
            if alpha < 1.0:
                entry["alphaMode"] = "BLEND"
            materials.append(entry)
            material_of[(color, alpha)] = len(materials) - 1
        return material_of[(color, alpha)]

    def placed(node, loc):
        shift, turn = loc
        if any(shift):
            node["translation"] = [value * METRES_PER_MM for value in shift]
        if list(turn) != IDENTITY_TURN:
            node["rotation"] = list(turn)
        nodes.append(node)
        return len(nodes) - 1

    def leaf(part):
        shape = part["shape"]
        if not shape.get("triangles"):
            return None
        # float32 before min and max are taken, so the bounds glTF requires are
        # the values in the buffer rather than their float64 originals.
        positions = (np.asarray(shape["vertices"], dtype=np.float64)
                     .reshape(-1, 3) * METRES_PER_MM).astype("<f4")
        attributes = {"POSITION": accessor(
            positions, ARRAY_BUFFER, FLOAT, "VEC3",
            min=positions.min(axis=0).tolist(),
            max=positions.max(axis=0).tolist())}
        normals = np.asarray(shape.get("normals") or (), dtype="<f4")
        if normals.size == positions.size:
            attributes["NORMAL"] = accessor(normals.reshape(-1, 3), ARRAY_BUFFER,
                                            FLOAT, "VEC3")
        indices = np.asarray(shape["triangles"], dtype="<u4")
        if indices.max() < UNSIGNED_SHORT_RESERVED:
            index = accessor(indices.astype("<u2"), ELEMENT_ARRAY_BUFFER,
                             UNSIGNED_SHORT, "SCALAR")
        else:
            index = accessor(indices, ELEMENT_ARRAY_BUFFER, UNSIGNED_INT,
                             "SCALAR")
        meshes.append({"name": part["name"], "primitives": [{
            "attributes": attributes, "indices": index,
            "material": material(part["color"], part["alpha"])}]})
        return placed({"name": part["name"], "mesh": len(meshes) - 1},
                      part["loc"])

    def group(entry):
        children = [index for index in
                    (leaf(part) if "shape" in part else group(part)
                     for part in entry["parts"])
                    if index is not None]
        node = {"name": entry["name"]}
        # glTF allows no empty `children`; a group of wires keeps its node.
        if children:
            node["children"] = children
        return placed(node, entry["loc"])

    top = group(document)
    nodes.append({"name": "root", "rotation": Z_UP_TO_Y_UP, "children": [top]})
    blob.extend(bytes(-len(blob) % 4))
    text = json.dumps({
        "asset": {"version": "2.0", "generator": "hammerola"},
        "scene": 0, "scenes": [{"nodes": [len(nodes) - 1]}],
        "nodes": nodes, "meshes": meshes, "materials": materials,
        "accessors": accessors, "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(blob)}],
    }, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    return b"".join([
        struct.pack("<III", GLB_MAGIC, GLB_VERSION, 28 + len(text) + len(blob)),
        struct.pack("<II", len(text), CHUNK_JSON), text,
        struct.pack("<II", len(blob), CHUNK_BIN), bytes(blob)])


def _linear(channel):
    """One sRGB channel, 0..255, as the linear value a glTF colour factor is."""
    value = channel / 255
    if value <= 0.04045:
        return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4
