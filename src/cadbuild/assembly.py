#!/usr/bin/env python3
"""The whole product as one file, and the pictures that go next to it.

Made in the same process that computed the geometry: on a `make build` that is
a container on the build node, and `_out/` is the only thing that comes back.
"""

import time

from .artifacts import ASSEMBLED_STEM, PREVIEW_SUFFIX, STL_ANGULAR_TOLERANCE, STL_TOLERANCE
from .errors import BuildError
from .geometry import as_shapes, drop_mesh
from .views import ASSEMBLED_VIEW_ID


# --------------------------------------------------------------------------
# Pictures, and the assembly as one file
# --------------------------------------------------------------------------
#
# These are made here, in the same process that computed the geometry, and for
# one reason: on a `make build` that geometry is computed inside a container on
# the build node, and `_out/` is the only thing that comes back. Rendering on
# this side afterwards would mean shipping the STLs back and re-reading them,
# and rendering in CI would mean the pictures existed only for pushes to main.

def assembled_shape(prepared, printables):
    """The whole product as one shape: the assembled view, glued.

    The `assembled` view is the authority on where the parts stand, so that is
    what gets written. Without one, the printables as they are -- for a
    single-part project that is the part, and for the rest it is at least
    everything that will be printed, in the coordinates the model handed over.

    Glued, not fused: a compound is one file and one download, and it is
    instant, where a boolean union of an assembly is minutes and can fail. The
    result is for looking at, not for slicing.
    """
    from cadquery.occ_impl.shapes import Compound

    objects = None
    for view in prepared:
        if view["id"] == ASSEMBLED_VIEW_ID:
            objects = view["objects"]
            break
    if objects is None:
        objects = list(printables.values())

    # Every body of every object: an object put together with .add() would
    # otherwise contribute its first solid only, and assembled.stl would be
    # missing parts that the viewer shows.
    shapes = [shape for obj in objects
              for shape in as_shapes(obj, "assembled")]
    if len(shapes) == 1:
        return shapes[0], objects
    return Compound.makeCompound(shapes), objects


def export_assembled(prepared, printables, out_dir):
    """Write `assembled.stl` -- the whole thing in one mesh.

    Returns how many bodies went into it. The preview needs that number and
    cannot get it from the file: parts that touch are welded into one body
    when the mesh is loaded, so a two-part assembly reads back as a single
    body that is not watertight.
    """
    from cadquery import exporters

    shape, objects = assembled_shape(prepared, printables)
    path = out_dir / f"{ASSEMBLED_STEM}.stl"
    # relative=False for the same reason as the printables above: OCC's
    # default scales the deflection per face and cracks the mesh where faces
    # of very different size meet.
    shape.exportStl(str(path), tolerance=STL_TOLERANCE,
                    angularTolerance=STL_ANGULAR_TOLERANCE,
                    ascii=False, relative=False)
    if not path.is_file():
        raise BuildError(f"{path.name} was not written")

    # Meshing happened in place on shapes the model still owns, and the
    # triangulation is shared through the TShape even by translated copies.
    # Leave it on and anything measuring a bounding box afterwards measures the
    # mesh (see drop_mesh).
    for obj in objects:
        drop_mesh(obj)
    # Bodies, not view objects: one object built with .add() is several parts.
    parts = sum(len(as_shapes(obj, "assembled")) for obj in objects)
    print(f"  {path.name}: {parts} parts, {path.stat().st_size / 1e6:.2f} MB")
    return parts


def render_previews(out_dir, stems, mode, parts=None):
    """One PNG per stem, rendered from the STL already written next to it.

    `mode` is "iso" (one isometric) or "multi" (the six-view sheet). The gate
    runs after every edit, so the default is the cheap one and the sheet is
    asked for: `make build VIEWS=multi`.

    `parts` maps a stem to how many parts its file holds; anything not in it
    is one part. The footer of a single-part picture says whether the mesh is
    watertight, which is the interesting fact about a part and a meaningless
    one about an assembly -- and the picture cannot work out which it is
    looking at, because touching parts weld into one body on load.

    A missing rendering stack is a warning, not a failure -- the geometry and
    the gate are what a build is for, and a python without matplotlib should
    still be able to publish one. A renderer that is there and then falls over
    is a real failure: silently shipping a build without the pictures it says
    it makes is how you end up looking at yesterday's.
    """
    # Imported here and not at the top of the module: `render` pulls in
    # matplotlib, numpy, trimesh and Pillow, and a python that has none of them
    # must still be able to import this package and publish a build.
    try:
        from . import preview_png as render_preview
    except Exception as exc:
        print(f"warning: no previews -- cadbuild.preview_png will not import "
              f"({type(exc).__name__}: {exc}). The geometry is unaffected.")
        return []

    written = []
    for stem in stems:
        stl = out_dir / f"{stem}.stl"
        if not stl.is_file():
            raise BuildError(f"cannot render {stem}: {stl.name} is missing")
        png = out_dir / f"{stem}{PREVIEW_SUFFIX}"
        started = time.monotonic()
        try:
            render_preview.render(str(stl), str(png), views=mode, title=stem,
                                  parts=(parts or {}).get(stem))
        except Exception as exc:
            raise BuildError(
                f"rendering {png.name} from {stl.name} failed "
                f"({type(exc).__name__}: {exc})"
            ) from exc
        print(f"  {png.name}: {png.stat().st_size / 1000:.0f} kB, "
              f"{time.monotonic() - started:.1f}s")
        written.append(png.name)
    return written
