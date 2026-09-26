"""The two whole-build artefacts: what goes onto the plate, and what is declared.

No kernel here, and none needed — which is the whole reason this file exists.
`print_plate_shape` picks a view and walks its objects, `export_print_plate`
measures, writes and cleans up after itself, and `overview_meshes` and
`preview_files` turn the evidence of what was written into the two maps that
declare it. The only caller of the export that runs the real thing is
`tests/test_template.py`, and that one skips wherever the kernel does not
import — no longer CI, whose image carries it (issue #27), but still any
machine without it, so anything asserted only there is unasserted on such a
machine.

The two calls that are genuinely the kernel's, `Compound.makeCompound` and
`drop_mesh`, are stood in for below; that they CAN be, on a python with no
CadQuery installed, is the reason both are reached at the point of use rather
than at the top of the module.
"""

from pathlib import Path
import sys
import types

import pytest

from src import cadbuild
from src.cadbuild import assembly, printables
from src.cadbuild.artifacts import (ASSEMBLED_STEM, ASSEMBLED_VIEW_ID,
                                    CARD_SUFFIX, PREVIEW_SUFFIX, PRINT_VIEW_ID)
from src.cadbuild.assembly import (assembled_shape, export_assembled,
                                   export_print_plate, print_plate_shape)
from src.cadbuild.errors import BuildError
from src.cadbuild.parts import RESERVED_STEMS
from src.cadbuild.printables import overview_meshes, preview_files

from fakes import Box, Mesh, Shape, Workplane, catalogue, node, part, view


class Recording(Shape):
    """A shape that writes down what is done to it, in the order it happened.

    `export_print_plate` measures the plate and then meshes it, and the meshing
    destroys the measurement — so WHICH CAME FIRST is the fact worth holding,
    and a value cannot hold it. This can.
    """

    def __init__(self, calls, box=None):
        super().__init__(box=box)
        self.calls = calls

    def BoundingBox(self):
        self.calls.append("bbox")
        return super().BoundingBox()

    def exportStl(self, path, **kwargs):
        self.calls.append("stl")
        Path(path).write_bytes(b"solid plate\nendsolid plate\n")


def plant_cadquery(monkeypatch, compound):
    """Make `from cadquery.occ_impl.shapes import Compound` resolve to `compound`.

    Planted in `sys.modules` rather than monkeypatched onto the real class,
    because the point is to run this on the python CI has, where `import
    cadquery` dies on a shared library. The three module entries are what that
    import statement walks, and monkeypatch puts back whatever was there — a
    real kernel included.
    """
    shapes = types.ModuleType("cadquery.occ_impl.shapes")
    shapes.Compound = compound
    for name, module in (("cadquery", types.ModuleType("cadquery")),
                         ("cadquery.occ_impl",
                          types.ModuleType("cadquery.occ_impl")),
                         ("cadquery.occ_impl.shapes", shapes)):
        monkeypatch.setitem(sys.modules, name, module)


@pytest.fixture
def glued(monkeypatch):
    """`Compound.makeCompound` as a recorder. -> the list of calls made."""
    calls = []

    class Compound:
        @staticmethod
        def makeCompound(shapes):
            calls.append(list(shapes))
            return ("compound", list(shapes))

    plant_cadquery(monkeypatch, Compound)
    return calls


@pytest.fixture
def exported(monkeypatch):
    """Everything the export reaches outside itself, made observable.

    Returns `(calls, dropped)`: the calls made on the shape that gets written,
    in order, and the objects `drop_mesh` was handed.

    `drop_mesh` is patched in `assembly`'s OWN namespace, because that is where
    the call looks it up — `from .geometry import drop_mesh` binds the name
    there, so patching `cadbuild.geometry` would leave the caller pointing at
    the real one, which imports OCP.

    The planted `makeCompound` hands back a `Recording` for the same reason the
    real one hands back a Shape: every line after it measures and exports what
    it returned.
    """
    calls, dropped = [], []

    class Compound:
        @staticmethod
        def makeCompound(shapes):
            return Recording(calls)

    plant_cadquery(monkeypatch, Compound)
    monkeypatch.setattr(assembly, "drop_mesh", dropped.append)
    return calls, dropped


def test_the_assembly_is_built_from_the_assembled_view_and_no_other():
    """It is the authority on where the parts stand. Taking whichever view came
    first would put the PLATE into assembled.stl -- parts laid out flat on a
    bed, published as the product."""
    standing = part()
    prepared = [view(PRINT_VIEW_ID, [node("body", part(x=50.0))]),
                view(ASSEMBLED_VIEW_ID, [node("body", standing)])]
    shape, objects = assembled_shape(prepared)
    assert objects == [standing]
    assert shape is standing.vals()[0]


def test_a_build_with_no_assembled_view_has_nothing_to_glue():
    """prepare_views refuses such a model, so this is the defensive half of that
    rule -- and it must not be a fallback: gluing something else would publish a
    file called `assembled.stl` that is not the assembly.

    No fixture, on purpose: this path must be answerable on a python with no
    CadQuery, which is what moving the `Compound` import to the point of use
    bought (see the twin list above assembled_shape).
    """
    with pytest.raises(BuildError) as exc:
        assembled_shape([view(PRINT_VIEW_ID, [node("body", part())])])
    assert "no 'assembled' view" in str(exc.value)


def test_every_body_of_every_object_reaches_the_assembly(glued):
    """The same `.add()` trap as on the plate: `val()` is the first body only,
    and assembled.stl would be missing parts the viewer shows."""
    first, second, third = Shape(), Shape(), Shape()
    prepared = [view(ASSEMBLED_VIEW_ID,
                     [node("pair", Workplane(first, second)),
                      node("single", Workplane(third))])]
    shape, objects = assembled_shape(prepared)
    assert glued == [[first, second, third]]
    assert shape == ("compound", [first, second, third])
    assert len(objects) == 2


def test_a_model_with_no_print_view_has_no_plate():
    """`None`, and not an error: a project is not obliged to have a print view.

    A single-part model whose one part is already in print orientation has
    nothing to lay out, and a build of it must not fail — nor be told off.
    """
    prepared = [view(ASSEMBLED_VIEW_ID, [node("body", part())])]
    assert print_plate_shape(prepared) is None


def test_the_plate_is_built_from_the_print_view_and_not_the_first_one():
    """The view is found by ID. Taking whichever view came first would put the
    ASSEMBLED arrangement into print.stl — parts standing where the product
    stands, not where the bed lays them out — and the picture would look
    entirely plausible."""
    on_the_bed = part(x=50.0)
    prepared = [
        view(ASSEMBLED_VIEW_ID, [node("body", part())]),
        view(PRINT_VIEW_ID, [node("body", on_the_bed)]),
    ]
    shape, objects = print_plate_shape(prepared)
    assert objects == [on_the_bed]
    assert shape is on_the_bed.vals()[0]


def test_every_body_of_every_object_reaches_the_plate(glued):
    """An object built with `.add()` is several solids in one Workplane.

    `val()` hands back the first of them, which is the defect `as_shapes`
    exists for: judged on its first body alone, a plate would be exported
    missing everything the model added afterwards — and the picture of it would
    show a bed that is not the one being printed.
    """
    first, second, third = Shape(), Shape(), Shape()
    prepared = [view(PRINT_VIEW_ID,
                     [node("pair", Workplane(first, second)),
                      node("single", Workplane(third))])]
    shape, objects = print_plate_shape(prepared)
    assert glued == [[first, second, third]]
    assert shape == ("compound", [first, second, third])
    # The OBJECTS come back as the model handed them over, not flattened: the
    # caller drops the mesh through them afterwards.
    assert len(objects) == 2


def test_the_plate_is_measured_before_it_is_meshed(exported, out_dir):
    """`BoundingBox()` BEFORE `exportStl()`, and nothing else can tell.

    exportStl meshes the shape in place, and from then on OCCT computes the
    bounding box off the MESH — out by tenths of a millimetre on anything
    filleted, which is the same trap `drop_mesh` exists for. Move the
    measurement below the export and every other fact here still holds: the
    file is written, the count is right, the meshes are dropped, and the only
    thing that changed is a number — the one metrics.json publishes as
    `assembly.print_bbox_mm` and `hammerola diff` prints as the plate's size
    (issue #58). So the order is what this asserts, and it is asserted here
    because the only other caller of this function skips wherever the kernel is
    missing.
    """
    calls, _ = exported
    shape = Recording(calls, box=Box(0, 0, 0, 3, 4, 5))
    prepared = [view(PRINT_VIEW_ID, [node("body", Workplane(shape))])]

    bodies, bbox = export_print_plate(prepared, out_dir)

    assert calls == ["bbox", "stl"]
    # Measured off the plate itself, not off some other shape in the view.
    assert (bbox.xlen, bbox.ylen, bbox.zlen) == (3, 4, 5)
    assert bodies == 1
    # And written under the one name this whole change turns on: `build`
    # declares `print.stl`, and `render_previews` makes the picture from it.
    assert [path.name for path in out_dir.iterdir()] == ["print.stl"]


def test_every_object_on_the_plate_has_its_mesh_dropped(exported, out_dir):
    """One missed object and a later measurement is quietly off.

    The triangulation is left on shapes the MODEL still owns, and `drop_mesh`
    cleans the bodies of the object it is handed and no others — so an object
    skipped here keeps its mesh, and whatever measures a bounding box afterwards
    (checks(), the metrics) measures the mesh rather than the geometry. What
    comes back is INFLATED by an amount that follows the export's deflection,
    which reads as a real measurement and not as a fault.

    This is what holds the loop to being a loop. A `.moved()` or `.located()`
    copy shares its triangulation through the TShape, so cleaning one object
    can look like it cleaned the others; a `.translate()` copy carries a TShape
    of its own and would keep its mesh. Both objects below arrive separately,
    so a call on the first alone leaves the second dirty and this goes red.
    """
    calls, dropped = exported
    single = Workplane(Recording(calls))
    # Built with .add(): one object the model handed over, two solids in it.
    pair = Workplane(Recording(calls), Recording(calls))
    prepared = [view(PRINT_VIEW_ID, [node("single", single), node("pair", pair)])]

    bodies, _ = export_print_plate(prepared, out_dir)

    assert dropped == [single, pair]
    # Bodies, not objects: the picture's footer would otherwise claim a
    # two-solid plate is watertight.
    assert bodies == 3


def test_the_assembly_is_measured_before_it_is_meshed(exported, out_dir):
    """The same order as the plate's, on the other export, and for the same
    reason it is worth a test of its own.

    `assembly.bbox_mm` is how big the product is, and exportStl meshes the
    shape in place — so a `BoundingBox()` moved below the export answers the box
    of the MESH, bigger by tenths of a millimetre on anything filleted. Nothing
    else here would notice: the file is still written, the count is still right,
    and the number is still plausible. It would read as the product having
    changed size on the very first build after the line moved.
    """
    calls, _ = exported
    shape = Recording(calls, box=Box(0, 0, 0, 30, 40, 50))
    prepared = [view(ASSEMBLED_VIEW_ID, [node("body", Workplane(shape))])]

    parts, bbox = export_assembled(prepared, out_dir,
                                   catalogue(body="printable"))

    assert calls == ["bbox", "stl"]
    # Measured off the assembly itself, not off some other shape in the view.
    assert (bbox.xlen, bbox.ylen, bbox.zlen) == (30, 40, 50)
    assert parts == 1
    assert [path.name for path in out_dir.iterdir()] == [f"{ASSEMBLED_STEM}.stl"]


def test_the_scenery_is_in_the_file_and_out_of_the_measurement(exported, out_dir):
    """A mock is drawn and not measured, and the two halves are the whole fix.

    `assembly.bbox_mm` exists to catch a part MOVED inside the assembly -- the
    one physical change no per-part number registers -- and a mock overlaps the
    product by construction, so a box that took the wall in would report the
    WALL: widening it prints "the product changed size" while the bracket
    sliding across it prints nothing at all. The mesh is the other half: the
    wall still goes into `assembled.stl`, which is a picture and wants its
    scenery.
    """
    calls, _ = exported
    product = Recording(calls, box=Box(0, 0, 0, 30, 40, 50))
    wall = Recording(calls, box=Box(-100, -100, -100, 200, 200, 200))
    prepared = [view(ASSEMBLED_VIEW_ID, [node("body", Workplane(product)),
                                         node("wall", Workplane(wall))])]

    parts, bbox = export_assembled(prepared, out_dir,
                                   catalogue(body="printable", wall="mock"))

    assert (bbox.xlen, bbox.ylen, bbox.zlen) == (30, 40, 50)
    # Both bodies went into the file, and the count is what the picture's footer
    # is told.
    assert parts == 2
    assert [path.name for path in out_dir.iterdir()] == [f"{ASSEMBLED_STEM}.stl"]


def test_a_mesh_leaf_is_drawn_and_never_glued(exported, out_dir):
    """The one thing `assembled.stl` leaves out, and why it is not a decision.

    A `mesh` entry holds a trimesh: there is nothing for `Compound.makeCompound`
    to glue and nothing for `exportStl` to mesh, so it cannot be in this file at
    any price -- while the view document the browser loads has it. It is out of
    the measurement too, but for the ordinary reason every mock is: scenery
    overlaps the product by construction.

    Passing is also the proof that `as_shapes` never saw it: a mesh leaf carries
    no `shape` at all, so reaching it would refuse the build.
    """
    calls, _ = exported
    product = Recording(calls, box=Box(0, 0, 0, 30, 40, 50))
    prepared = [view(ASSEMBLED_VIEW_ID, [node("body", Workplane(product)),
                                         node("scan", Mesh())])]

    parts, bbox = export_assembled(prepared, out_dir,
                                   catalogue(body="printable",
                                             scan=("mock", Mesh())))

    assert (bbox.xlen, bbox.ylen, bbox.zlen) == (30, 40, 50)
    # ONE body in the file, not two: the mesh is not in it.
    assert parts == 1
    assert [path.name for path in out_dir.iterdir()] == [f"{ASSEMBLED_STEM}.stl"]


def test_a_view_of_nothing_but_scenery_has_no_product_to_measure(exported,
                                                                 out_dir):
    """`None`, and not a box: there is no product in this view to be the size of.

    Zeroes would be this build saying it made something of no size, and the
    scenery's own box would be the very number the mocks are kept out of. The
    file is still written -- the picture is the scenery -- so this is an absent
    measurement rather than a failed export.

    NO PUBLISHED BUILD LOOKS LIKE THIS, and the test says so on purpose: this
    view is assembled by hand, past `read_catalogue` (which refuses a catalogue
    of nothing but hardware and scenery) and past `check_assembled_coverage`
    (which refuses a model whose assembled view does not show every printable).
    What is pinned is the defensive half of those two, so that the answer stays
    an absence and never becomes three zeroes.
    """
    calls, _ = exported
    wall = Recording(calls, box=Box(0, 0, 0, 200, 200, 200))
    prepared = [view(ASSEMBLED_VIEW_ID, [node("wall", Workplane(wall))])]

    parts, bbox = export_assembled(prepared, out_dir, catalogue(wall="mock"))

    assert bbox is None
    assert parts == 1
    assert [path.name for path in out_dir.iterdir()] == [f"{ASSEMBLED_STEM}.stl"]


def test_a_plate_whose_export_wrote_no_file_is_a_build_error(exported, out_dir):
    """An export that returns without writing must not pass for a success.

    Everything downstream believes the file exists: `render_previews` reads it
    to draw the picture, `build` names it in `files`, and the hub hashes what it
    finds there. Unchecked, the build reports success and publishes a download
    button pointing at nothing.
    """
    calls, dropped = exported

    class Silent(Recording):
        def exportStl(self, path, **kwargs):
            self.calls.append("stl")

    prepared = [view(PRINT_VIEW_ID, [node("body", Workplane(Silent(calls)))])]
    with pytest.raises(BuildError) as exc:
        export_print_plate(prepared, out_dir)
    assert "print.stl was not written" in str(exc.value)
    # Raised before the cleanup, so nothing claims to have tidied up after a
    # mesh that was never made.
    assert dropped == []


@pytest.fixture
def planted_renderer(monkeypatch):
    """`render_previews`' own `from . import preview_png`, answered by a stub.

    The renderer is a SOFT dependency: a python with no numpy, no Pillow or no
    matplotlib makes that import fail, and `render_previews` then warns and
    returns nothing written rather than failing a build (`tests/test_template.py`
    pins that degradation). A test about the refusals BELOW the import would
    otherwise be a test of whether the drawing stack happens to be installed.

    The stub refuses to draw, and that is the other half of what is asserted: a
    picture whose scene is missing is refused before anything is rendered.
    """
    stub = types.ModuleType("src.cadbuild.preview_png")

    def render(*args, **kwargs):
        raise AssertionError("a picture was drawn after it should have been "
                             "refused")

    stub.render = render
    monkeypatch.setattr(cadbuild, "preview_png", stub, raising=False)
    return stub


def test_a_picture_whose_scene_file_is_missing_is_refused(planted_renderer,
                                                          out_dir):
    """The twin of the missing STL, and it guards the newer half of the wiring.

    A whole-view picture is drawn from the tessellated view DOCUMENT rather than
    from the mesh -- that is where the colours, the alphas and the placements
    are -- so the document is as load-bearing as the STL beside it. Missing, the
    renderer would quietly draw the STL instead and the build would publish one
    flat-blue blob under the name of a picture of the assembly, which is exactly
    the picture this renderer replaced.

    The mesh IS there, so what is refused is the scene and not the stem.
    """
    (out_dir / f"{ASSEMBLED_STEM}.stl").write_bytes(b"solid a\nendsolid a\n")

    with pytest.raises(BuildError) as exc:
        assembly.render_previews(
            out_dir, [ASSEMBLED_STEM], "iso",
            scenes={ASSEMBLED_STEM: f"{ASSEMBLED_VIEW_ID}.json"})

    assert f"cannot render {ASSEMBLED_STEM}" in str(exc.value)
    assert f"{ASSEMBLED_VIEW_ID}.json is missing" in str(exc.value)
    # And nothing was written for it: a half-drawn picture would be declared by
    # `build` and served by the hub.
    assert list(out_dir.iterdir()) == [out_dir / f"{ASSEMBLED_STEM}.stl"]


@pytest.fixture
def drawing_renderer(monkeypatch):
    """A `preview_png` stub that writes the files it is told to and records them.

    The same planting as `planted_renderer` above with the refusal turned round:
    that one exists to prove nothing was drawn, this one to see WHAT was. It
    cannot be the real renderer -- numpy, Pillow and matplotlib are a soft
    dependency of this package and this file is written to run without them --
    and it need not be: what is under test is which pictures `render_previews`
    ASKS for, per stem, which is its own decision and not the rasteriser's.

    The bytes are a PNG magic number and nothing more; `render_previews` only
    stats what it wrote, to print its size.
    """
    drawn = []
    stub = types.ModuleType("src.cadbuild.preview_png")

    def render(stl_path, output_path, card_path=None, **kwargs):
        Path(output_path).write_bytes(b"\x89PNG\r\n\x1a\n")
        if card_path is not None:
            Path(card_path).write_bytes(b"\x89PNG\r\n\x1a\n")
        drawn.append((Path(output_path).name,
                      None if card_path is None else Path(card_path).name))
        return output_path

    stub.render = render
    monkeypatch.setattr(cadbuild, "preview_png", stub, raising=False)
    return drawn


def test_a_card_is_drawn_for_a_whole_view_and_never_for_a_part(
        drawing_renderer, out_dir):
    """The front page's picture, and the one stem rule that decides who gets one.

    A card is a picture of a PROJECT, so what it can show is a whole view -- the
    assembly or the plate -- and never one printable out of ten. `scenes` is
    already the answer to "is this stem a whole view": a view is drawn from the
    tessellated document the browser loads, and a part from its own STL. So the
    card follows that map rather than a second list, and this is what holds the
    two together.

    THE RETURN VALUE IS THE DECLARATION. `build` files these names on the view
    entries of meta.json and puts them on the list the hub hashes, so a card
    written and not returned is a file nobody can reach, and a card returned for
    a part is a pointer at a file that was never written -- a 422 on the push.
    """
    for stem in (ASSEMBLED_STEM, "base"):
        (out_dir / f"{stem}.stl").write_bytes(b"solid a\nendsolid a\n")
    (out_dir / f"{ASSEMBLED_VIEW_ID}.json").write_text("{}", encoding="utf-8")

    written, cards = assembly.render_previews(
        out_dir, [ASSEMBLED_STEM, "base"], "iso",
        scenes={ASSEMBLED_STEM: f"{ASSEMBLED_VIEW_ID}.json"})

    assert written == [f"{ASSEMBLED_STEM}{PREVIEW_SUFFIX}",
                       f"base{PREVIEW_SUFFIX}"]
    assert cards == {ASSEMBLED_STEM: f"{ASSEMBLED_STEM}{CARD_SUFFIX}"}
    # The renderer was ASKED for exactly that, which is the half a returned map
    # cannot show: a card the build declares and nobody draws is a 404 under an
    # immutable URL.
    assert drawing_renderer == [
        (f"{ASSEMBLED_STEM}{PREVIEW_SUFFIX}", f"{ASSEMBLED_STEM}{CARD_SUFFIX}"),
        (f"base{PREVIEW_SUFFIX}", None)]
    # And the files are really there, the part's card absent among them.
    assert (out_dir / f"{ASSEMBLED_STEM}{CARD_SUFFIX}").is_file()
    assert not (out_dir / f"base{CARD_SUFFIX}").exists()


def test_a_build_with_no_print_view_writes_nothing_at_all(out_dir):
    """`None`, and not a file: the short circuit comes before the path is built.

    A project is not obliged to have a `print` view, and `build` has a branch
    for that — but a `print.stl` left in the output here, of any size, would be
    declared by nothing, rendered from by nothing and served anyway.

    No fixture: this path must reach neither the kernel nor `drop_mesh`, so the
    test is written on a python that has neither planted.
    """
    prepared = [view(ASSEMBLED_VIEW_ID, [node("body", part())])]
    assert export_print_plate(prepared, out_dir) is None
    assert list(out_dir.iterdir()) == []


def test_the_overview_declares_both_meshes_keyed_by_their_stems():
    """Two entries, and the KEY is the stem rather than a button caption.

    Compared whole, because both halves of an entry are worth holding: the key
    is what a reader picks an entry out by (`meta["overview"]["print"]`), and
    the value is the file name the hub serves. Neither draws anything — this
    map exists so a client can be TOLD the mesh is there.
    """
    meshes = overview_meshes(plate=True)
    assert meshes == {ASSEMBLED_STEM: f"{ASSEMBLED_STEM}.stl",
                      PRINT_VIEW_ID: f"{PRINT_VIEW_ID}.stl"}


def test_the_overview_declares_exactly_the_stems_the_build_reserves():
    """Two lists of the same two names, with nothing tying them but this.

    `RESERVED_STEMS` is what refuses a printable called `assembled` or `print`;
    `overview_meshes` is what writes those names into meta.json. A third
    whole-build mesh added to the map alone reopens the exact overwrite the
    reservation exists to prevent — the part is exported to `<stem>.stl` by the
    printable loop, the whole-build artefact overwrites that file afterwards,
    and the hub hashes whatever is left, so the published file is the wrong one
    under the part's own download button with nothing anywhere saying so.

    Compared against `plate=True` because the plate is the conditional half of
    the map and no half of the reservation: a project with no `print` view still
    may not call a part `print` (see RESERVED_STEMS), so the two only line up
    against a build that writes both.
    """
    assert set(overview_meshes(plate=True)) == set(RESERVED_STEMS)


def test_nothing_about_the_plate_is_declared_without_one():
    """`plate=False` is the project with no `print` view, which is allowed.

    Declaring `print.stl` anyway would turn a supported shape of project into a
    refused publication: the hub only accepts a declared name that is a key of
    the output hash (`render.build_meta`), and nothing wrote that file.
    """
    meshes = overview_meshes(plate=False)
    assert meshes == {ASSEMBLED_STEM: f"{ASSEMBLED_STEM}.stl"}


def test_every_picture_that_was_rendered_is_declared_under_its_own_stem():
    """The per-part pictures included, which is what this map was added for.

    A part's picture used to be declared by nothing at all — the only map was
    `downloads`, and putting ten of them in there would have put ten buttons on
    the page — so the only way to reach one was to assemble its URL out of the
    part name and the suffix, by hand, and that breaks silently the day either
    moves. The stem is the key because the reader holds a part NAME.
    """
    previews = preview_files([
        f"base{PREVIEW_SUFFIX}",
        f"{ASSEMBLED_STEM}{PREVIEW_SUFFIX}",
        f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}",
    ])
    assert previews == {
        "base": f"base{PREVIEW_SUFFIX}",
        ASSEMBLED_STEM: f"{ASSEMBLED_STEM}{PREVIEW_SUFFIX}",
        PRINT_VIEW_ID: f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}",
    }


def test_no_picture_is_declared_when_none_was_rendered():
    """`written=[]` is the no-matplotlib build, which is a supported degradation.

    Declaring the pictures anyway would turn it into a refused publication, for
    the reason the plate above is not declared without one. `build` then leaves
    the key out of meta.json entirely rather than publishing an empty object.
    """
    assert preview_files([]) == {}


def test_a_stem_rename_that_makes_the_key_illegal_is_refused_here(monkeypatch):
    """The guard inside `overview_meshes`, reached the only way it can be.

    It is unreachable by construction TODAY -- both stems are constants that
    satisfy MEMBER_RE -- so a test that merely calls the function and re-applies
    MEMBER_RE to what came back asserts nothing at all: the function applied it
    first and would have raised. What the guard is for is the rename that lands
    later, and a rename is what this stages. A slash is the shape of rename that
    is easiest to reach for and worst to publish, because it reads as tidying
    the artefacts into a subdirectory and the hub takes no name with one in it.

    The constant is patched in THIS module's namespace, which is where the
    function looks it up: `from .artifacts import ASSEMBLED_STEM` binds a name
    here, so patching `cadbuild.artifacts` would leave this one pointing at the
    old string.

    Without the guard the illegal key reaches the hub as an opaque 422 on the
    push, with the build itself reporting success.
    """
    monkeypatch.setattr(printables, "ASSEMBLED_STEM", "whole/assembled")
    with pytest.raises(BuildError) as exc:
        overview_meshes(plate=False)
    assert "whole/assembled" in str(exc.value)
    # The message has to send the reader to the module the renamed constant is
    # in. All three stems this map and the picture map are built from live in
    # one module now, so the message names one -- it used to name two, because
    # PRINT_VIEW_ID lived in cadbuild.views until the catalogue needed to
    # reserve that stem without importing it.
    assert "cadbuild.artifacts" in str(exc.value)
    assert "cadbuild.views" not in str(exc.value)


def test_a_rendered_file_that_is_not_a_picture_is_refused_rather_than_declared(
        monkeypatch):
    """The same guard on the other map, reached by renaming the suffix.

    `preview_files` takes the stem off by stripping PREVIEW_SUFFIX, and a name
    that does not end in it has no stem at all. Declaring it under the empty
    string would publish a map whose key nothing can look up and whose entry the
    hub then refuses -- so the empty stem is refused here, where the message can
    still name the constant that moved.
    """
    monkeypatch.setattr(printables, "PREVIEW_SUFFIX", ".preview.png")
    with pytest.raises(BuildError) as exc:
        preview_files([f"base{PREVIEW_SUFFIX}"])
    assert f"base{PREVIEW_SUFFIX}" in str(exc.value)
    assert "cadbuild.artifacts" in str(exc.value)
