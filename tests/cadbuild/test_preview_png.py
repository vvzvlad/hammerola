"""The preview renderer, against the view document the browser really loads.

WHAT THESE HOLD is the half of a build nothing else can notice. The previews
were drawn with matplotlib's mplot3d, which has no z-buffer and painted every
part in one blue: an assembly came out a single blue blob with its own far wall
showing through the near one, and no build ever went red over it. Both of those
are properties of a PICTURE, so the only thing that ever caught them was
somebody opening the PNG — which is the state this file exists to leave.

KERNEL-FREE, like everything else in this directory. The renderer takes
triangles rather than CadQuery shapes, and `ui/tests/fixtures/assembled.json` is
a REAL tessellated view document — four parts, three palette colours and one
see-through leaf, written by a real build through
ui/tests/fixtures/make_fixture.py. What these hand the renderer is byte for byte
what the browser is handed.
"""

from pathlib import Path
from types import SimpleNamespace
import json
import math

import numpy as np
import pytest
from PIL import Image

# The MODULE rather than matplotlib, numpy or Pillow by name: this is the import
# `assembly.render_previews` itself tries, and a python missing any one of the
# three degrades to "warning: no previews" rather than failing a build. Skipping
# here is that same supported degradation and not a broken renderer.
preview_png = pytest.importorskip(
    "src.cadbuild.preview_png", exc_type=ImportError,
    reason="the preview renderer does not import in this interpreter, so there "
           "is no picture to check — a supported degradation, not a failure")

import trimesh  # noqa: E402  (guarded by the importorskip above)

# The catalogue half, for the one test that runs a colour the whole way through:
# what `parts` hands on is what this renderer is given. Neither needs the
# drawing stack, and they sit here only because the guard above comes first.
from fakes import part  # noqa: E402
from src.cadbuild.parts import catalogue_colors, read_catalogue  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "ui" / "tests" / "fixtures" / "assembled.json"

# The fixture's four leaves, by the colour each one is painted. Three palette
# entries and one hardware grey, which is what `catalogue_colors()` gives a
# catalogue of three printables and a bought part.
PLATE = "#c9a227"
POST = "#4682b4"
CAP = "#7f8c4a"
SPACER = "#3f444b"


def _shows(image, color):
    """Is any pixel of `image` this colour under this renderer's lights?

    Shading multiplies a part's colour by ONE brightness per face, so every lit
    pixel of that part is the colour scaled — parallel to it, never a different
    hue. Asking for an exact RGB would be asking what the lights are; asking for
    the direction is asking what the part was painted in, which is the question.
    """
    base = preview_png._hex_rgb(color)
    pixels = np.unique(np.asarray(image).reshape(-1, 3), axis=0) / 255.0
    level = (pixels @ base) / (base @ base)
    residual = np.linalg.norm(pixels - level[:, None] * base, axis=1)
    return bool(((level > 0.05) & (residual < 0.02)).any())


def _square(x, half, color):
    """A flat square of side `2 * half` standing at `x`, facing the +X camera."""
    return {
        "vertices": np.array([[x, -half, -half], [x, half, -half],
                              [x, half, half], [x, -half, half]], dtype=float),
        "faces": np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64),
        "color": color,
        "alpha": 1.0,
    }


def test_a_leaf_stands_where_its_loc_puts_it():
    """The placement is the difference between an assembly and a pile.

    A leaf's `vertices` are the part's OWN coordinates and its `loc` is where
    the view puts it, so a renderer that reads one and not the other draws every
    part on the origin — and draws it perfectly, which is why this is asserted on
    the numbers rather than left to the eye. The fixture's cap is modelled about
    z=0 and stood on top of a 15 mm post.
    """
    scene = preview_png.load_scene(FIXTURE)
    cap = next(part for part in scene if part["color"] == CAP)

    assert cap["vertices"][:, 2].min() == pytest.approx(13.5)
    assert cap["vertices"][:, 2].max() == pytest.approx(16.5)


def test_a_turned_leaf_inside_a_turned_group_lands_where_the_composition_puts_it(
        tmp_path):
    """The QUATERNION, which every leaf of the committed fixture leaves at the
    identity — so `_rotation` and `_placed` are otherwise exercised on
    translation alone.

    A `print` view legitimately turns parts about Z to lay them flat, so a
    `[w, x, y, z]` read of a `[x, y, z, w]` quaternion, or a transposed rotation
    matrix, would turn every part in `print_preview.png` and nothing but a human
    opening the picture would ever say so. Hence a document written here, with
    numbers worked out by hand rather than read back off the renderer:

      * the group turns +90° about Z, the leaf inside it +90° about X, so the
        composition maps x->y, y->z, z->x;
      * the leaf also stands 10 mm along ITS OWN +X, which the group's rotation
        turns into +10 along Y.

    The two rotations are deliberately different axes: 90° about one axis is its
    own transpose only for 180°, and this pair is not symmetric, so a transposed
    matrix moves the answer.
    """
    quarter = math.sqrt(0.5)
    document = {
        # [qx, qy, qz, qw], which is the order the tessellator writes.
        "loc": [[0.0, 0.0, 0.0], [0.0, 0.0, quarter, quarter]],
        "parts": [{
            "loc": [[10.0, 0.0, 0.0], [quarter, 0.0, 0.0, quarter]],
            "shape": {"vertices": [1.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 3.0],
                      "triangles": [0, 1, 2]},
            "color": POST,
            "alpha": 1.0,
        }],
    }
    turned = tmp_path / "print.json"
    turned.write_text(json.dumps(document), encoding="utf-8")

    (leaf,) = preview_png.load_scene(turned)

    assert leaf["vertices"] == pytest.approx(np.array([[0.0, 11.0, 0.0],
                                                       [0.0, 10.0, 2.0],
                                                       [3.0, 10.0, 0.0]]))
    # AND A PLAIN SUM OF OFFSETS DOES NOT REPRODUCE THAT, which is the sentence
    # `_placed`'s docstring makes and the reason the composition cannot be one:
    # the group's rotation turns the child's translation too. Below is what the
    # same scene comes to when only the ROTATIONS are composed and the two
    # translations are added — the part 10 mm out along the wrong axis, in a
    # picture that otherwise looks entirely plausible.
    summed = np.array([[10.0, 1.0, 0.0], [10.0, 0.0, 2.0], [13.0, 0.0, 0.0]])
    assert not np.allclose(leaf["vertices"], summed)


def test_every_part_is_drawn_in_its_own_colour():
    """Three parts, three colours, all of them in one frame.

    This is the whole point of drawing from the view document: the colours are
    the catalogue's, per part, and they are the ones the reader is looking at in
    the browser. One blue for everything passed every test there was.
    """
    frame = preview_png.render_view(preview_png.load_scene(FIXTURE),
                                    *preview_png.ISO_VIEW, 200)

    assert _shows(frame, PLATE)
    assert _shows(frame, POST)
    assert _shows(frame, CAP)


def test_a_colour_the_catalogue_took_by_name_is_one_this_renderer_can_draw():
    """`"red"` is a colour to the tessellator and nothing at all to `_hex_rgb`.

    The catalogue validates a colour with the tessellator's own parser, which
    takes `"red"`, `"#f00"` and `"steelblue"`; this renderer reads exactly six
    hex digits. While `parts._check_color` handed back the author's own string,
    a part named by a CSS colour passed every gate in the build and then died
    inside the PNG of itself — a model that built yesterday going red today,
    with a message about a picture. So the validator canonicalises, and this is
    the two halves meeting: what the catalogue carries is what the renderer is
    handed.
    """
    pytest.importorskip("ocp_tessellate", exc_type=ImportError,
                        reason="colour parsing uses the tessellator's parser")
    catalogue = read_catalogue(SimpleNamespace(parts=lambda: {
        "body": {"shape": part(), "kind": "printable", "color": "red"}}))

    color = catalogue_colors(catalogue)["body"]

    assert color == "#ff0000"
    # Drawn, and not merely hex: `_hex_rgb` is reached through `render_view`,
    # which is where the ValueError used to come from.
    frame = preview_png.render_view([_square(0.0, 6.0, color)], 0.0, 0.0, 41)
    assert _shows(frame, color)


def test_the_nearer_of_two_overlapping_parts_wins_the_pixel():
    """A z-buffer decides per pixel, and the draw ORDER decides nothing.

    Both halves are needed to say that. The small square is drawn FIRST in both,
    so a painter's algorithm — which is what mplot3d gave this file, and what
    made a box show its own far wall through the near one — would hand the
    centre pixel to the big square every time.
    """
    big = _square(0.0, 6.0, PLATE)
    size = 61
    centre = size // 2

    in_front = np.asarray(preview_png.render_view(
        [_square(5.0, 2.0, POST), big], 0.0, 0.0, size))
    behind = np.asarray(preview_png.render_view(
        [_square(-5.0, 2.0, POST), big], 0.0, 0.0, size))

    assert _shows(in_front[centre, centre], POST)
    assert _shows(behind[centre, centre], PLATE)
    # And the small square covers the middle only: the big one is still there
    # around it, so the first assertion is about depth and not about an empty
    # frame.
    assert _shows(in_front[centre, centre + 25], PLATE)


def test_a_see_through_part_shows_what_is_behind_it_rather_than_hiding_it():
    """The `clear` half of `render_view`, which the opaque one never reaches.

    A leaf between 0 and 1 is blended over whatever is already in the frame
    instead of taking the pixel, and the pixel then belongs to NEITHER part: it
    is `back * (1 - a) + front * a`, which is what the viewer's own material
    does and what makes a transparent case show the parts inside it.

    THE TWO ENDS ARE MEASURED RATHER THAN COMPUTED. Both squares face the camera
    the same way, so each one drawn opaque and alone gives exactly the shade it
    contributes here — asking for a literal RGB would be asking what the lights
    are, which is `_shading`'s business and not this test's.
    """
    alpha = 0.4
    size = 61
    centre = size // 2
    back = _square(0.0, 6.0, PLATE)
    front = dict(_square(5.0, 2.0, SPACER), alpha=alpha)

    blended = np.asarray(preview_png.render_view([back, front], 0.0, 0.0, size))
    opaque_back = np.asarray(preview_png.render_view([back], 0.0, 0.0, size))
    opaque_front = np.asarray(
        preview_png.render_view([_square(5.0, 2.0, SPACER)], 0.0, 0.0, size))

    pixel = blended[centre, centre].astype(float)
    expected = (opaque_back[centre, centre] * (1.0 - alpha)
                + opaque_front[centre, centre] * alpha)
    # Within a step or two of 255: the frame is float until the very last line,
    # and the two ends are read back after that rounding while the blend
    # happened before it.
    assert pixel == pytest.approx(expected, abs=2.0)
    # And that is a real mixture and not one of the two: a pixel showing either
    # part's own colour would mean the near one took the pixel outright or was
    # never drawn at all.
    assert not _shows(pixel, SPACER)
    assert not _shows(pixel, PLATE)


def _cube(half, color):
    """A solid cube of half-edge `half` about the origin: a part that FILLS its
    own bounding box, which is what makes the framing visible at all."""
    box = trimesh.creation.box(extents=(2 * half, 2 * half, 2 * half))
    return {"vertices": np.asarray(box.vertices, dtype=float),
            "faces": np.asarray(box.faces, dtype=np.int64),
            "color": color, "alpha": 1.0}


def test_a_part_is_not_cropped_by_its_own_picture():
    """The frame is measured on the PROJECTION and not on the bounding box.

    A cube of half-edge h is 2h across seen down an axis and 2h*sqrt(3) across
    seen corner-on. A scale taken from h therefore fits the face-on views and
    pushes the corners of every other one off the edge — which is exactly what
    shipped for one build: the template's assembled preview ran off the left and
    the right of its own picture, because mplot3d used to do this measuring and
    nothing inherited it. Asserted on the BORDER of the frame, because that is
    where the part went.
    """
    size = 120
    frame = np.asarray(preview_png.render_view([_cube(10.0, PLATE)],
                                               *preview_png.ISO_VIEW, size))
    border = np.concatenate([frame[0], frame[-1], frame[:, 0], frame[:, -1]])
    background = np.round(preview_png._hex_rgb(preview_png.BACKGROUND) * 255)

    assert (border == background).all(), (
        "the part reaches the edge of the frame, so the picture is cropped")
    # ...and it did not simply come out tiny: the cube is still there in the
    # middle, so the assertion above is about the framing and not about an empty
    # picture.
    assert _shows(frame[size // 2, size // 2], PLATE)


def test_one_field_serves_every_view_of_a_sheet():
    """The six tiles are read against each other, so they are at one scale.

    A field measured per tile would draw the same part at six different sizes,
    and a reader comparing two of them could not tell that from a part that
    changed. So a sheet takes the LARGEST field any of its views needs: the
    widest tile fits exactly and the others have room to spare.
    """
    parts = [_cube(10.0, PLATE)]
    angles = [(elev, azim) for elev, azim, _label in preview_png.MULTI_VIEWS]
    alone = [preview_png.framing(parts, [angle])[1] for angle in angles]

    _centre, sheet = preview_png.framing(parts, angles)

    assert sheet == pytest.approx(max(alone))
    assert sheet > min(alone), (
        "a cube is wider corner-on than face-on, so these cannot all come back "
        "equal — if they do, the projection is not being measured"
    )


def test_a_leaf_at_alpha_zero_is_not_drawn(tmp_path):
    """Hidden in the viewer, hidden here — the two pictures agree or neither is.

    Alpha 0 is how a view says a part is there and not shown. Drawn anyway, it
    is an opaque part in the middle of the assembly that nobody looking at the
    browser can see, and the preview stops being a picture of the same thing.
    """
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    post = next(leaf for leaf in document["parts"] if leaf["color"] == POST)
    post["alpha"] = 0.0
    hidden = tmp_path / "hidden.json"
    hidden.write_text(json.dumps(document), encoding="utf-8")

    frame = preview_png.render_view(preview_png.load_scene(hidden),
                                    *preview_png.ISO_VIEW, 200)

    assert not _shows(frame, POST)
    # The other two are still drawn, so what vanished is the leaf and not the
    # picture.
    assert _shows(frame, PLATE)
    assert _shows(frame, CAP)


def test_a_scene_render_writes_a_png_of_the_scene(tmp_path):
    """End to end: two documents in, one file out.

    `render` reads BOTH — the scene for the picture, the STL for the footer —
    and the STL here is a plain box that shares nothing with the scene. So the
    fixture's colours in the output are proof of which of the two was drawn.
    """
    stl = tmp_path / "assembled.stl"
    trimesh.creation.box(extents=(10.0, 20.0, 30.0)).export(stl)
    png = tmp_path / "assembled_preview.png"

    written = preview_png.render(str(stl), str(png), title="assembled",
                                 parts=4, resolution=120, scene=str(FIXTURE))

    assert written == str(png)
    assert png.is_file()
    with Image.open(png) as picture:
        drawn = picture.convert("RGB")
    assert _shows(drawn, PLATE)
    assert _shows(drawn, CAP)


def test_where_a_chunk_boundary_falls_cannot_move_a_pixel(monkeypatch):
    """FRAGMENT_BUDGET is a memory ceiling and must be nothing else.

    Every chunk is resolved against the same z-buffer, so the split is supposed
    to be invisible in the answer — and that is the whole licence for retuning
    the number, which on any real model decides how many times the loop runs and
    nothing about what it draws. Held on the BYTES of the frame: a boundary that
    dropped a scanline or double-blended one would move a handful of pixels in a
    picture nobody diffs.
    """
    parts = [_cube(10.0, PLATE)]
    whole = preview_png.render_view(parts, *preview_png.ISO_VIEW, 120)

    monkeypatch.setattr(preview_png, "FRAGMENT_BUDGET", 7)
    chunked = preview_png.render_view(parts, *preview_png.ISO_VIEW, 120)

    assert chunked.tobytes() == whole.tobytes()
    # ...and seven rows really did split this work, so the equality above is a
    # statement about chunking rather than about a budget nothing reached.
    # Chunk boundaries fall BETWEEN triangles, so one triangle is one chunk
    # however wide it is — hence a band of them.
    band = np.array([[[0.0, y, 1.0], [40.0, y, 1.0], [20.0, y + 10.0, 1.0]]
                     for y in range(0, 100, 10)])
    assert len(list(preview_png._fragments(band, 120))) > 1
