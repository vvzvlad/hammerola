#!/usr/bin/env python3
"""parts() -- the catalogue, and the ONE place a model's geometry lives.

The key of an entry IS the part's identity. It is the file stem a printable is
exported under, the label the viewer's tree shows, the name a view points at,
and the key everything about the part is filed under in meta.json. Nothing
anywhere works out what a part is from its shape or from a string that looks
like its name.

A view is a list of REFERENCES into this catalogue and carries no geometry, so
there is no second copy of a part to disagree with the first. The one exception
is the deformed hatch (see views.py), which has to name a reason.

    def parts():
        return {
            "lid":      {"shape": lid,   "kind": "printable"},
            "screw_m3": {"shape": screw, "kind": "hardware",
                         "note": "M3x8 DIN912"},
            "board":    {"shape": board, "kind": "mock"},
            "scan":     {"mesh": scan,   "kind": "mock"},
        }

An entry carries `shape` -- a CadQuery object this build computes with -- or
`mesh`, a `trimesh.Trimesh` the model loaded itself (`trimesh` is in the image
and `ref/` travels to the hub with the source, so a scan lives beside
model.py). Never both: one key is one piece of geometry, and two of them under
one name would be two parts sharing an identity.
"""

from .artifacts import ASSEMBLED_STEM, PRINT_VIEW_ID
from .errors import BuildError
from .geometry import as_shape
from .hubspec import MAX_NOTE_CHARS, MAX_PARTS, MEMBER_RE, hub_text_problem
from .modelchecks import call_model
from .palette import HARDWARE_COLOR, MOCK_COLOR, palette_colors


# What a part IS, and there are exactly three answers. The kind decides what
# the build does with the entry, so it is required and has NO DEFAULT: a
# defaulted `printable` would silently export STL/STEP/3MF for a mock of a
# bought bearing and put download buttons on a public page offering it.
KIND_PRINTABLE = "printable"
KIND_HARDWARE = "hardware"
# `mock` is scenery: gate.check_interference skips any pair with a mock on
# either side, since a wall or a board overlaps the product by construction.
# `hardware` stays under the gate: a screw thread biting into a printed hole is
# exactly the overlap that must be declared with a reason.
KIND_MOCK = "mock"
# In the order they are offered in every message: what you print, what you buy,
# what is only there so the picture makes sense.
KINDS = (KIND_PRINTABLE, KIND_HARDWARE, KIND_MOCK)

# Every key one catalogue entry is read for. `kind` is required and so is
# exactly one of `shape`/`mesh`; `color` and `note` are not. THERE IS NO DISPLAY
# NAME, deliberately: the key is the name, in every view and in every file, and a
# second name would be a second identity to keep in step with the first.
RECORD_KEYS = frozenset({"shape", "mesh", "kind", "color", "note"})

# The three arrays a mesh leaf is written from (`views._mesh_leaf`), plus the
# extent the scene's bounding box has to be widened by (`views._widen_bb`).
# Asked of the object HERE, where a catalogue still costs milliseconds: the same
# absence found in the tessellation phase is an AttributeError out of a build
# that has already computed and exported every part.
MESH_ATTRS = ("vertices", "vertex_normals", "faces", "bounds")

# The stems this build keeps for itself. A printable exported to `<stem>.stl`
# would be silently overwritten by the whole-build artefact of that name.
#
# The reservation is unconditional even though `print.stl` exists only when the
# project has a `print` view: the view may be added after the part is named. It
# applies to every kind, since the key also names view nodes and meta.json
# entries, and a kind change would otherwise turn it into a real collision.
RESERVED_STEMS = {
    ASSEMBLED_STEM: "the glued-together assembly",
    PRINT_VIEW_ID: "the print plate",
}


def check_stem(stem, made):
    """The key of a whole-build map, or a BuildError naming the rename.

    MEMBER_RE, which is the rule a name that becomes part of a FILE is held to:
    128 characters, and the alphabet the hub will serve that file under. It is
    deliberately not held to any shorter caption-shaped rule -- nothing below
    is a caption.

    Catalogue keys already passed MEMBER_RE in `read_catalogue`, so this
    catches a bad rename of ASSEMBLED_STEM, PREVIEW_SUFFIX or PRINT_VIEW_ID in
    cadbuild.artifacts, which would otherwise surface as a 422 on the push.
    """
    if not MEMBER_RE.match(stem):
        raise BuildError(
            f"{made} would be declared under the key {stem!r}, which is not a "
            "filename stem: letters, digits, dot, dash and underscore, "
            "starting with a letter or a digit. Every catalogue key passed "
            "that rule already, so a rename is what reaches this -- of "
            "ASSEMBLED_STEM, PREVIEW_SUFFIX or PRINT_VIEW_ID in "
            "cadbuild.artifacts."
        )
    return stem


def _check_key(key):
    """A catalogue key, or the BuildError that says what is wrong with it."""
    if not isinstance(key, str):
        # str() would invent a name nobody wrote and then export a file under
        # it: the key is a filename stem, a tree label and a meta.json key.
        raise BuildError(
            f"catalogue key {key!r} is a {type(key).__name__} and not a "
            "string. A key is the part's identity: the stem it is exported "
            "under, the name every view points at, and -- through those "
            "references -- the name the viewer's tree shows. (It is the "
            "reference that carries the name into the viewer, not this entry: "
            "a part no view points at is drawn nowhere and labelled nothing.)"
        )
    if not MEMBER_RE.match(key):
        raise BuildError(
            f"catalogue key {key!r} is not usable as a filename stem "
            "(allowed: letters, digits, dot, dash and underscore, starting "
            "with a letter or a digit, up to 128 characters). A printable is "
            f"exported to {key!r}.stl, and the key is what names it."
        )
    if key in RESERVED_STEMS:
        # Worded as a reservation: `print.stl` exists only when the project
        # has a `print` view.
        raise BuildError(
            f"catalogue key {key!r} is reserved: {key}.stl is the name this "
            f"build keeps for {RESERVED_STEMS[key]}. Call the part something "
            "else."
        )
    return key


def _check_color(color, where):
    """An explicit colour from the catalogue, canonicalised to `#rrggbb`.

    Checked with the tessellator's own parser, imported at the point of use
    rather than at the top of the file: most catalogues name no colour at all,
    so most builds never pay for the import. A bad colour is otherwise found by
    export_views, after every part has been exported and meshed -- minutes
    spent on an answer visible now.

    Returns the parser's canonical spelling: it accepts `"red"`, `"#f00"` and
    `"steelblue"`, but `preview_png._hex_rgb` reads exactly six hex digits, so
    everything downstream gets one spelling.

    AN 8-DIGIT `#rrggbbaa` LOSES ITS ALPHA HERE, and that costs nothing:
    transparency travels separately, as the `alpha` of the reference that
    places the part, and `views.export_views` hands the tessellator `alphas=`
    explicitly rather than letting it read one off a colour.
    """
    color = str(color).strip()
    if not color:
        raise BuildError(
            f'{where}: "color" is empty. Leave the key out and the part is '
            "painted by what it IS -- the palette for a printable, grey for a "
            "mock, dark grey for hardware."
        )
    from ocp_tessellate.utils import Color
    try:
        parsed = Color(color)
    except Exception as exc:
        raise BuildError(f"{where}: color {color!r} is not one ({exc})") from exc
    return parsed.web_color


def _check_mesh(mesh, where):
    """Somebody else's geometry, held to the four attributes the build reads.

    A DUCK TYPE AND NOT `isinstance(trimesh.Trimesh)`, because `MESH_ATTRS` is
    the whole of what this build asks of one and an import would buy nothing
    over it: most catalogues hold no mesh at all, and this is the phase whose
    point is that it costs milliseconds. What it catches is the author's own
    slip -- a Workplane written under `mesh`, a path written instead of a loaded
    mesh -- which is what `as_shape` catches on the other side.

    `tests/cadbuild/test_naming.py` checks a real Trimesh against the same list.
    """
    missing = [name for name in MESH_ATTRS if not hasattr(mesh, name)]
    if not missing:
        return mesh
    raise BuildError(
        f'{where}: "mesh" is a {type(mesh).__name__}, which has no '
        f"{', '.join(missing)}. A mesh is a trimesh.Trimesh the model loaded "
        'itself -- `trimesh.load("ref/scan.stl", force="mesh")` -- and the '
        "build draws it from its vertices, vertex_normals and faces. A "
        'CadQuery object goes under "shape".'
    )


def _check_note(note, where):
    """The author's note on a part, held to the hub's own rules for it."""
    if not isinstance(note, str):
        # Not stringified, for the reason a key is not: str() would turn a
        # number or a list into a sentence nobody wrote and then show it to
        # every reader of the model.
        raise BuildError(
            f'{where}: "note" is {note!r}, which is a {type(note).__name__} '
            "and not a string. A note is the text shown to whoever looks at "
            'this part: {"shape": screw, "kind": "hardware", "note": '
            '"M3x8 DIN912"}.'
        )
    note = note.strip()
    if not note:
        # An empty note is a sentence somebody meant to write, not a part with
        # nothing to say -- that one leaves the key out.
        raise BuildError(
            f'{where}: "note" is empty. Leave the key out for a part there is '
            "nothing to say about; an empty string is a note that was started "
            "and not written."
        )
    if len(note) > MAX_NOTE_CHARS:
        raise BuildError(
            f'{where}: "note" is {len(note)} characters, over the '
            f"{MAX_NOTE_CHARS} the hub accepts. A note is one line about the "
            "part -- a catalogue name, a link, the fit that was taken -- and "
            "not the documentation of it."
        )
    # The ceiling is answered above, with a message of its own, so what is left
    # for the shared rule here is the CHARACTERS.
    problem = hub_text_problem(note, MAX_NOTE_CHARS)
    if problem:
        raise BuildError(
            f'{where}: "note" {problem}: {note!r}. The hub checks every note '
            "again on the way in and answers 422, so this is a whole build's "
            "worth of geometry spent on a sentence. `clearance < 0.2 mm` is "
            "the one that catches everybody: an angle bracket is text that "
            "could open an element on a page shared with every other project "
            "on the host, so write it as `0.2 mm clearance` instead."
        )
    return note


def read_catalogue(model):
    """parts(), validated, with every entry normalised to the same five keys.

    Runs before any view is looked at and before a single triangle exists: all
    of it is rules about strings and about the shape of a dict, so a catalogue
    that cannot be read costs milliseconds rather than a build.

    ORDER IS PRESERVED, because reproducibility depends on it: the export loop,
    the metrics and the picture list all walk this dict, and a build that
    reordered them would produce a different log for an unchanged model.

    A DOOR INTO THE MODEL (`modelchecks.MODEL_DOORS` is the list of them): the
    call is what raises an author's exception as `parts() raised TypeError
    (model.py:12): ...` instead of leaving the build to report that the hub
    crashed. Only the CALL is guarded -- what comes back is read below, and a
    bug of OURS in that reading is a bug of ours, not something to hand the
    author as "the model said no".
    """
    catalogue = call_model("parts()", model.parts)
    if not isinstance(catalogue, dict) or not catalogue:
        raise BuildError(
            'parts() must return a non-empty dict: {"lid": {"shape": lid, '
            '"kind": "printable"}, ...}'
        )
    # The hub's own ceiling (`render.MAX_PARTS`), mirrored so the build fails
    # before spending its geometry on a 422. It counts records, which is what
    # sizes meta.json.
    if len(catalogue) > MAX_PARTS:
        raise BuildError(
            f"parts() returned {len(catalogue)} entries, over the {MAX_PARTS} "
            "the hub accepts from one build. Every entry is published in "
            "meta.json, which every visitor of the build downloads."
        )

    read = {}
    for key, record in catalogue.items():
        _check_key(key)
        where = f"catalogue entry {key!r}"
        if not isinstance(record, dict):
            raise BuildError(
                f"{where} is {type(record).__name__}, not a dict. Every entry "
                'is written {"shape": <CadQuery object>, "kind": "printable"}, '
                'with optional "color" and "note".'
            )

        shape = record.get("shape")
        mesh = record.get("mesh")
        if shape is not None and mesh is not None:
            # ONE ENTRY IS ONE PIECE OF GEOMETRY. Two would be two parts under
            # one identity, and every reader downstream -- the export, the
            # gates, the tessellation -- would have to pick, differently in each
            # place, which of them this key means.
            raise BuildError(
                f'{where} carries both "shape" and "mesh". One is a CadQuery '
                "object this build computes with, the other a mesh the model "
                "loaded; an entry has exactly one of them. Give the mesh a "
                "catalogue key of its own."
            )
        if shape is None and mesh is None:
            raise BuildError(
                f'{where} has no "shape" and no "mesh": there is nothing to '
                "build"
            )
        if shape is not None:
            as_shape(shape, where)
        else:
            _check_mesh(mesh, where)

        if "kind" not in record:
            raise BuildError(
                f'{where} has no "kind". There is no default, on purpose: '
                f"{KIND_PRINTABLE!r} would export STL/STEP/3MF for a part and "
                "put download buttons under it, which is exactly the wrong "
                "thing to do to a mock of something bought. Write one of "
                f"{', '.join(repr(k) for k in KINDS)}."
            )
        kind = record["kind"]
        if kind not in KINDS:
            raise BuildError(
                f'{where}: "kind" is {kind!r}, which is not one of '
                f"{', '.join(repr(k) for k in KINDS)}. "
                f"{KIND_PRINTABLE!r} is exported and gets download buttons, "
                f"{KIND_HARDWARE!r} is bought and goes into the product, "
                f"{KIND_MOCK!r} is only there so the picture makes sense."
            )
        if mesh is not None and kind != KIND_MOCK:
            # A mesh has no solid to export, judge for printability, or
            # intersect, and `mock` is already exempt from all three.
            raise BuildError(
                f'{where} is a "mesh" declared {kind!r}, and a mesh has to be '
                f"{KIND_MOCK!r}. It is geometry that came from somewhere else: "
                "there is no solid in it to export, nothing to put on a bed, "
                "and nothing the interference gate could measure -- which is "
                f"exactly what {KIND_MOCK!r} already means here. A scan is the "
                "thing the part is designed around, so scenery is what it is."
            )

        color = record.get("color")
        if color is not None:
            color = _check_color(color, where)

        note = record.get("note")
        if note is not None:
            note = _check_note(note, where)

        unknown = sorted(set(record) - RECORD_KEYS)
        if unknown:
            # A warning and not an error, for the reason the view-level one is:
            # this contract is shared by every project in the organisation, and
            # a key somebody added for their own tooling must not turn into a
            # red build. But a misspelt "colour" leaves the part painted by the
            # palette and says nothing, so it is said out loud.
            print(
                f"warning: {where} has key(s) "
                f"{', '.join(repr(k) for k in unknown)}, which the build does "
                f"not read. Known keys: {', '.join(sorted(RECORD_KEYS))}."
            )

        read[key] = {"shape": shape, "mesh": mesh, "kind": kind,
                     "color": color, "note": note}

    if not printable_keys(read):
        raise BuildError(
            "the catalogue has nothing to print: every entry is "
            f"{KIND_HARDWARE!r} or {KIND_MOCK!r}. A model project exists to "
            "produce a part, so at least one entry has to be "
            f"{KIND_PRINTABLE!r}."
        )

    return read


def printable_keys(catalogue):
    """The keys of everything that goes on a bed, in catalogue order."""
    return [key for key, record in catalogue.items()
            if record["kind"] == KIND_PRINTABLE]


def catalogue_colors(catalogue):
    """`{key: colour}` for the whole catalogue: what each part is drawn in.

    An explicit `color` in the entry always wins -- the author knows something
    the build does not, and there is exactly one place to write it now.
    Everything else is painted by what the part IS, which is what makes the
    picture readable at a glance: a palette entry means it is printed, dark
    grey means it is bought, light grey means it is only scenery.

    "Do not colour a mock" is a rule of the SKILL and deliberately not of this
    build: an author who has a reason to paint one is not wrong, and a gate
    that refused it would be refusing a picture rather than a part.
    """
    palette = palette_colors(printable_keys(catalogue))
    automatic = {KIND_PRINTABLE: palette.get,
                 KIND_HARDWARE: lambda key: HARDWARE_COLOR,
                 KIND_MOCK: lambda key: MOCK_COLOR}
    return {key: record["color"] or automatic[record["kind"]](key)
            for key, record in catalogue.items()}
