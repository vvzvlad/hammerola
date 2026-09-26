#!/usr/bin/env python3
"""views() -> what the viewer loads: references into the catalogue, tessellated.

A VIEW CARRIES NO GEOMETRY. It is a selection of references into `parts()`,
which is the one place a part exists, so a view cannot show a part the
catalogue does not have and cannot show a look-alike in place of one. That is
the whole change: identity used to be RECONSTRUCTED afterwards -- by matching
shapes and by matching name strings -- and both reconstructions were wrong in
ways nobody could see from a green build.

    def views():
        return [
            {"id": "assembled", "parts": [
                {"group": "housing", "parts": ["lid", {"part": "pin", "at": p1}]},
                "board",
             ],
             "interference_ok": [("nozzle", "seat", "threaded joint")]},
            {"id": "print", "parts": [{"part": "lid", "at": shift}, "pin"]},
        ]

Three forms of reference, and no fourth:

  * a string -- the catalogue key, the part exactly as the catalogue holds it;
  * `{"part": key, "at": Location, "alpha": 0.6}` -- the same part, placed. `at`
    is a rigid motion applied by the build, so there is nothing to check about
    it beyond where it is allowed to turn (see the print gate);
  * `{"part": key, "shape": bent, "deformed": "clamped round the pipe"}` -- the
    ONE way geometry gets into a view, for a part that is genuinely a different
    shape in place. The reason is required and is printed into the build log,
    because an unexplained second shape under a part's name is exactly the
    decoy this design exists to refuse. NOT IN THE `print` VIEW: on a bed there
    is no "in place" to be a different shape in, and the plate is a file
    (see _refuse_deformed_on_the_plate).

A reference to a `mesh` entry (parts.py) takes neither `at` nor the
`shape`/`deformed` hatch; `alpha` still applies. `at` is REFUSED because it is
applied with `Shape.moved()`, which a trimesh has no answer for, so a mesh
arrives in the frame the model put it in -- transform it with trimesh before
handing it to the catalogue. The hatch is REFUSED because a mesh entry has no
shape of its own to be a different shape from, and that second refusal is what
holds the leaf names apart (see `_mesh_leaf`).

A group -- `{"group": "housing", "parts": [...]}`, nested to `MAX_VIEW_DEPTH`
and REFUSED past it -- is presentation and nothing else: it is the author's own
structure, not a classification by kind, and no gate can see it. Every gate
reads the flat list of leaves.
"""

import json
import time

from . import checklib
from .artifacts import ASSEMBLED_VIEW_ID, PRINT_VIEW_ID
from .errors import BuildError
from .geometry import as_shapes
from .hubspec import (MAX_VIEW_DEPTH, MAX_VIEW_NAME_CHARS, MEMBER_RE,
                      RESERVED_NAMES, hub_text_problem)
from .palette import DEFAULT_ALPHA, INVISIBLE_ALPHA, NEARLY_OPAQUE_MIN
from .parts import KIND_MOCK, catalogue_colors


# Every key a view dict is read for. Anything else is reported as unknown --
# `nestedok` for `nested_ok` used to be accepted in silence, and a silent
# exemption is one that is not there.
VIEW_KEYS = frozenset({"id", "name", "parts", "nested_ok", "interference_ok"})
# ...and every key one REFERENCE is read for. Only `part` is required.
REFERENCE_KEYS = frozenset({"part", "at", "alpha", "shape", "deformed"})
# ...and a GROUP is exactly these two, both required.
GROUP_KEYS = frozenset({"group", "parts"})

# The three axes a bounding box is measured on. The viewer reads the six numbers
# as `xmin`/`xmax` and so on, which is the spelling `_widen_bb` writes.
BB_AXES = ("x", "y", "z")


def prepare_views(views, catalogue):
    """Validate everything views() returned, before any work is done.

    Split out from the tessellation so the whole contract -- ids, every
    reference, the groups, the exemption lists -- is settled while it still
    costs milliseconds. Tessellation is the slow half of a build, and finding a
    bad id after it is time spent on an answer already known.

    What comes out, per view:

        {"id", "label", "file",
         "nested_ok":       {frozenset((key, key)), ...},
         "interference_ok": {frozenset((key, key)): "reason"},
         "tree":            groups and leaf indices, for the export,
         "nodes":           [{"key", "shape", "mesh", "color", "alpha", "at",
                              "deformed", "label"}, ...]}

    `nodes` IS THE FLAT LIST OF LEAVES and it is what every gate reads; `tree`
    holds the author's grouping and is read only when the view file is written.
    The two are kept apart on purpose: a gate that could see a group would have
    to decide what a group MEANS, and a group means nothing -- it is how the
    author chose to file the parts for a reader.

    The parallel full-length lists this used to return (objects/names/colors/
    alphas) are gone: an index in four lists is a contract nothing holds
    together, and it is the exact place identity used to be lost.
    """
    if not isinstance(views, (list, tuple)) or not views:
        raise BuildError("views() must return a non-empty list")

    colors = catalogue_colors(catalogue)
    prepared = []
    seen = set()
    for index, view in enumerate(views):
        if not isinstance(view, dict):
            raise BuildError(f"view #{index} is not a dict")
        vid = str(view.get("id") or "").strip()
        if not MEMBER_RE.match(vid):
            raise BuildError(f"view #{index} has a bad id {vid!r}")
        if vid in seen:
            raise BuildError(f"duplicate view id {vid!r}")
        seen.add(vid)

        # The view's own caption, checked here because export_views writes it
        # into meta.json and the hub reads it back with `_plain_text(...,
        # "view name")` -- an unchecked one is a 422 handed to a build that has
        # already been computed. `str()` and the fallback to the id are
        # transcribed too: the hub does exactly both.
        label = str(view.get("name") or vid)
        problem = hub_text_problem(label, MAX_VIEW_NAME_CHARS,
                                   angle_brackets_ok=True)
        if problem:
            raise BuildError(
                f'view {vid!r}: "name" {problem}: {label!r}. It is the caption '
                "in the view picker, it travels in meta.json, and the hub "
                "checks it again on the way in -- answering 422 on a build "
                "that already ran. Keep it to plain, printable text, or leave "
                f'the key out and the view is captioned {vid!r}.')

        tree, nodes = read_parts(view, vid, catalogue, colors)
        _label_nodes(nodes)
        _refuse_deformed_on_the_plate(vid, nodes)
        _warn_about_transparency(vid, nodes)

        filename = f"{vid}.json"
        if filename in RESERVED_NAMES:
            raise BuildError(f"view {vid!r} would overwrite {filename}, which the hub owns")

        # Both exemption lists are validated HERE, for every view that carries
        # one, and not inside the gate that reads them. Validating at the point
        # of use meant a list was only ever looked at in the one view its gate
        # runs on: rubbish anywhere else went through in silence, and so did
        # the whole exemption when the key was misspelt.
        #
        # ABSENT IS THE ONLY THING THAT MEANS "NOTHING DECLARED", which is why
        # neither line below is `view.get(...) or ()`. That reads a key that is
        # THERE and unusable -- `nested_ok: 0`, `False`, `""` -- as a view that
        # declared nothing, so the one shape a mistake actually takes gets the
        # silence a correct absence gets. `nested_ok: 5` is already named by the
        # refusals these two raise; `nested_ok: ""` would slip past them without
        # this, and the asymmetry would be a coin toss over one character.
        keys = {node["key"] for node in nodes}
        declared = view.get("nested_ok")
        nested_ok = nested_pairs(() if declared is None else declared, keys, vid)
        if nested_ok and vid != PRINT_VIEW_ID:
            # Not an error: it is a correct list, in a view nothing reads it
            # from. Saying so beats letting the author believe an overlap
            # somewhere is exempt.
            print(
                f"warning: view {vid!r} declares nested_ok, which only the "
                f"{PRINT_VIEW_ID!r} view is checked against. Parts are "
                "supposed to touch in every other view, so nothing here is "
                "exempting anything."
            )
        declared = view.get("interference_ok")
        interference_ok = interference_pairs(
            () if declared is None else declared, keys, vid)
        if interference_ok and vid != ASSEMBLED_VIEW_ID:
            print(
                f"warning: view {vid!r} declares interference_ok, which only "
                f"the {ASSEMBLED_VIEW_ID!r} view is checked against. Nothing "
                "here is exempting anything."
            )
        # The third dead declaration, and the one that MISREADS rather than
        # merely doing nothing: check_interference prints every entry of this
        # list into the build log as an exemption it ran with ("may overlap --
        # <reason>"), while a pair naming a mock was never asked about at all --
        # scenery is skipped before a single box is compared. So the log would
        # say an overlap is excused where nothing looked. Saying so beats
        # letting the author believe an overlap somewhere is exempt, exactly as
        # for the two above.
        mocks = sorted({key for pair in interference_ok for key in pair
                        if catalogue[key]["kind"] == KIND_MOCK})
        if mocks:
            print(
                f"warning: view {vid!r} declares interference_ok naming "
                f"{', '.join(repr(key) for key in mocks)}, which the catalogue "
                f"holds as {KIND_MOCK!r}. A mock is scenery -- the gate never "
                "asks whether it shares space with anything -- so the "
                "declaration takes no check off, and whatever it was written "
                "for was never going to be reported."
            )

        unknown_keys = sorted(set(view) - VIEW_KEYS)
        if unknown_keys:
            # A warning and not an error, deliberately: this file is shared by
            # every project in the organisation, and a key somebody added for
            # their own tooling must not turn into a red build. But a silent
            # `nestedok` is an exemption that is simply not there, and the
            # author has no way to tell from a green run.
            print(
                f"warning: view {vid!r} has key(s) "
                f"{', '.join(repr(k) for k in unknown_keys)}, which the build "
                f"does not read. Known keys: {', '.join(sorted(VIEW_KEYS))}. "
                "A misspelt one does nothing and says nothing."
            )

        prepared.append({
            "id": vid,
            "label": label,
            "file": filename,
            "nested_ok": nested_ok,
            "interference_ok": interference_ok,
            "tree": tree,
            "nodes": nodes,
        })

    if not any(view["id"] == ASSEMBLED_VIEW_ID for view in prepared):
        raise BuildError(
            f"there is no {ASSEMBLED_VIEW_ID!r} view. It is what the product "
            "is judged by and the only view the build counts parts from, so "
            "every model has one -- for a single-part model it is one "
            f'reference: {{"id": "{ASSEMBLED_VIEW_ID}", "parts": ["<the '
            'part>"]}.'
        )
    return prepared


def read_parts(view, vid, catalogue, colors):
    """One view's `parts` as `(tree, nodes)`.

    `nodes` is every LEAF in the order the author wrote them, each one already
    placed (`at` applied) and coloured. `tree` mirrors the author's structure:
    a group is `{"group": name, "parts": [...]}` and a leaf is the INDEX of its
    entry in `nodes`, so the leaf data has exactly one owner and the grouping
    cannot drift away from it.
    """
    parts = view.get("parts")
    if not isinstance(parts, (list, tuple)) or not parts:
        raise BuildError(
            f"view {vid!r} has no parts. A view is a list of references into "
            'the catalogue: "parts": ["lid", {"part": "pin", "at": here}, ...]'
        )
    nodes = []
    tree = _read_entries(parts, vid, catalogue, colors, nodes, depth=1,
                         where=f"view {vid!r}")
    return tree, nodes


def _read_entries(entries, vid, catalogue, colors, nodes, depth, where):
    """The recursive half of read_parts: one level of `parts`, in order."""
    if depth > MAX_VIEW_DEPTH:
        # The hub's ceiling, transcribed (see hubspec.MAX_VIEW_DEPTH). It also
        # bounds the recursion below, so a pathological nest is refused rather
        # than turning into a RecursionError out of a build.
        raise BuildError(
            f"{where} nests groups deeper than the {MAX_VIEW_DEPTH} the hub "
            "accepts. A group is how a reader is shown the assembly, not a "
            "data structure to hide depth in."
        )
    if not isinstance(entries, (list, tuple)) or not entries:
        raise BuildError(
            f'{where} has an empty "parts". A group with nothing in it is a '
            "row in the tree that opens onto nothing; take it out or put "
            "something in it."
        )

    built = []
    # Group names ARE unique among siblings, and nothing else checks it. A
    # leaf's uniqueness is the tessellator's doing -- it disambiguates repeats
    # of one name into `pin`, `pin(2)` -- but a group's name is written by this
    # build, straight into `id` as `<parent>/<name>`, so two `housing` groups
    # side by side get one and the same id. `render.check_view_file` on the hub
    # does not look at ids, so that publishes into an immutable build in
    # silence. Names at DIFFERENT depths are fine and are not tracked here:
    # the parent's id is part of the child's, so they cannot collide.
    named = set()
    for index, entry in enumerate(entries):
        spot = f"{where} entry #{index}"
        if isinstance(entry, str):
            built.append(_read_reference({"part": entry}, vid, catalogue,
                                         colors, nodes, spot))
            continue
        if not isinstance(entry, dict):
            raise BuildError(
                f"{spot} is {type(entry).__name__}, not a catalogue key or a "
                'dict. Write a reference as "lid" or {"part": "lid", "at": '
                'here}, and a group as {"group": "housing", "parts": [...]}.'
            )
        if "group" in entry:
            if "part" in entry:
                raise BuildError(
                    f'{spot} has both "group" and "part". A group holds '
                    "references; it is not one."
                )
            name = _check_group_name(entry.get("group"), catalogue, spot)
            if name in named:
                raise BuildError(
                    f"{spot}: there is already a group called {name!r} beside "
                    "it. Two groups at one level under one name are one row of "
                    "the tree meaning two different things -- they are written "
                    "into the view file under the same id, so the viewer's own "
                    "path cannot tell them apart and neither can a reader. "
                    "Give them names that say which is which."
                )
            named.add(name)
            unknown = sorted(set(entry) - GROUP_KEYS)
            if unknown:
                print(
                    f"warning: {spot} (group {name!r}) has key(s) "
                    f"{', '.join(repr(k) for k in unknown)}, which the build "
                    f"does not read. Known keys: {', '.join(sorted(GROUP_KEYS))}."
                )
            built.append({
                "group": name,
                "parts": _read_entries(entry.get("parts"), vid, catalogue,
                                       colors, nodes, depth + 1,
                                       f"{where} group {name!r}"),
            })
            continue
        built.append(_read_reference(entry, vid, catalogue, colors, nodes, spot))
    return built


def _check_group_name(name, catalogue, spot):
    """A group's name: the same alphabet as a catalogue key, and never one.

    It is written into the view file as a node name and the viewer builds a
    path out of it, exactly as it does for a leaf -- so it is held to the same
    rule for the same reason. It may not BE a catalogue key: the tree would
    then hold two different things under one name, and a reader picking the row
    called `housing` would have no way to tell which one they got.
    """
    if not isinstance(name, str):
        raise BuildError(
            f'{spot}: "group" is {name!r}, which is a {type(name).__name__} '
            'and not a string. Write it out: {"group": "housing", "parts": '
            "[...]}."
        )
    name = name.strip()
    if not MEMBER_RE.match(name):
        raise BuildError(
            f"{spot}: group name {name!r} is not usable (allowed: letters, "
            "digits, dot, dash and underscore, starting with a letter or a "
            "digit, up to 128 characters). It is a node name in the view file "
            "and the viewer builds a path out of it, so it is held to the "
            "same rule as a catalogue key."
        )
    if name in catalogue:
        raise BuildError(
            f"{spot}: group name {name!r} is also a catalogue key. One name in "
            "the tree would then mean two things -- the group and the part -- "
            "and neither the viewer's path nor a reader can tell them apart."
        )
    return name


def _read_reference(entry, vid, catalogue, colors, nodes, spot):
    """One reference into the catalogue -> the index of the node it made."""
    key = entry.get("part")
    if key is None:
        raise BuildError(
            f'{spot} has no "part": nothing says which catalogue entry it '
            "shows."
        )
    if not isinstance(key, str):
        raise BuildError(
            f'{spot}: "part" is {key!r}, which is a {type(key).__name__} and '
            "not a catalogue key."
        )
    if key not in catalogue:
        raise BuildError(
            f"{spot} points at {key!r}, which is not in the catalogue "
            f"({', '.join(repr(k) for k in catalogue) or 'it is empty'}). A "
            "view shows what parts() holds and nothing else -- add the part "
            "to the catalogue, or fix the key."
        )
    record = catalogue[key]

    at = entry.get("at")
    if at is not None and not hasattr(at, "wrapped"):
        raise BuildError(
            f'{spot}: "at" is {at!r}, which is not a cq.Location. It is the '
            "rigid motion the build applies to the catalogue's own solid: "
            'cq.Location((10, 0, 0)) moves it, cq.Location(cq.Vector(0, 0, 0), '
            "cq.Vector(0, 0, 1), 90) turns it."
        )

    shape = entry.get("shape")
    reason = entry.get("deformed")
    if shape is not None and reason is None:
        raise BuildError(
            f'{spot} carries a "shape". Geometry lives in the catalogue, so a '
            "view holds a reference to it -- the one exception is a part that "
            "is genuinely a different shape in place, and it has to say why: "
            '{"part": "%s", "shape": <the bent one>, "deformed": "clamped '
            'round the pipe"}. Placing a part is "at", not "shape".' % key
        )
    if reason is not None:
        if shape is None:
            raise BuildError(
                f'{spot} says "deformed" and hands over no "shape". The reason '
                "is for a shape that differs from the catalogue's; without one "
                "there is nothing it explains."
            )
        if not isinstance(reason, str) or not reason.strip():
            raise BuildError(
                f'{spot}: "deformed" is {reason!r}. The reason is required and '
                "has to say something: it is the whole difference between a "
                "part that is bent in place and a second solid nobody can "
                'account for. {"deformed": "clamped round the pipe"}.'
            )
        reason = reason.strip()
        # A MESH ENTRY HAS NOTHING FOR THIS HATCH TO DIFFER FROM, and letting
        # it through is worse than meaningless. The tessellator names the solid
        # leaf after the key, `_mesh_leaf` numbers the mesh occurrences of that
        # key on its own, and the two then meet on one name: the tree comes out
        # with two nodes on one id. Nothing downstream says so -- the hub's
        # check does not read ids, and the viewer silently drops one of the two
        # (measured in comparescene.py) -- so it reaches a published build.
        if record["mesh"] is not None:
            raise BuildError(
                f'{spot} carries a "shape", and the catalogue holds {key!r} as '
                'a mesh. "deformed" is for a part that is a different shape in '
                "place, and a mesh entry has none of its own to differ from. A "
                "mesh that is a different shape is a different mesh: load or "
                "build the deformed one and give it a catalogue key of its own."
            )
        as_shapes(shape, spot)
        # Printed rather than merely stored: this is the one place a view may
        # hold geometry, and a reader of the log has to be able to see every
        # one of them without opening the model. No `warning:` prefix -- a
        # declared deformation is legal and the author has already explained
        # it.
        print(f"  {vid}: {key!r} carries geometry of its own -- {reason}")

    # WHICH KIND OF GEOMETRY THIS LEAF IS. A reference that brought its own
    # `shape` points at a solid entry -- the refusal above is what makes that
    # true -- so the catalogue answers this on its own.
    mesh = record["mesh"]
    if mesh is not None and at is not None:
        raise BuildError(
            f'{spot}: "at" was given for a mesh. `at` is applied with '
            "Shape.moved(), which a trimesh has no answer for, so a mesh "
            "arrives in the frame the model put it in: transform it there -- "
            "`mesh.apply_transform(...)`, `mesh.apply_translation(...)` -- "
            "before handing it to the catalogue."
        )

    alpha = entry.get("alpha", DEFAULT_ALPHA)
    if isinstance(alpha, bool) or not isinstance(alpha, (int, float)):
        raise BuildError(
            f"{spot}: alpha is {alpha!r}, which is not a number. "
            f"Transparency runs 0..1 and defaults to {DEFAULT_ALPHA}."
        )
    alpha = float(alpha)
    if not 0.0 <= alpha <= 1.0:
        raise BuildError(
            f"{spot}: alpha is {alpha:g}, outside 0..1. 0 is invisible and 1 "
            "is opaque; there is nothing on either side of that, and the "
            "viewer clamps silently rather than telling you."
        )

    unknown = sorted(set(entry) - REFERENCE_KEYS)
    if unknown:
        # A warning for the reason the view-level one is: a misspelt "alfa"
        # leaves the part opaque and would otherwise say nothing at all.
        print(
            f"warning: {spot} has key(s) "
            f"{', '.join(repr(k) for k in unknown)}, which the build does not "
            f"read. Known keys: {', '.join(sorted(REFERENCE_KEYS))}."
        )

    nodes.append({
        "key": key,
        # EXACTLY ONE OF THE TWO IS None ON EVERY LEAF, which is what lets
        # everything downstream route on `node["mesh"] is None` rather than
        # asking the catalogue again.
        "shape": None if mesh is not None else _placed(
            shape if shape is not None else record["shape"], at, spot),
        "mesh": mesh,
        "color": colors[key],
        "alpha": alpha,
        "at": at,
        "deformed": reason,
    })
    return len(nodes) - 1


def _placed(obj, at, where):
    """The catalogue's own object, moved to where this reference puts it.

    `at` is applied HERE and once, so everything downstream -- the gates, the
    plate, the tessellation -- reads one solid standing where the view says it
    stands. The catalogue's object is never touched: `Shape.moved` returns a
    copy, and a Workplane is rebuilt around the moved bodies with `newObject`
    so an object made with `.add()` keeps all of them.
    """
    if at is None:
        return obj
    shapes = as_shapes(obj, where)
    for shape in shapes:
        if not hasattr(shape, "moved"):
            raise BuildError(
                f'{where}: "at" was given, but {type(shape).__name__} cannot '
                "be moved. `at` is applied with Shape.moved(), which every "
                "CadQuery solid has."
            )
    moved = [shape.moved(at) for shape in shapes]
    if hasattr(obj, "newObject"):
        return obj.newObject(moved)
    # Anything without a stack is exactly one shape (as_shapes says so), and a
    # Compound is one of those: it goes in whole, as the model handed it over.
    return moved[0]


def _label_nodes(nodes):
    """Name every leaf for a message, telling repeats of one key apart.

    Several references to one part are ordinary and expected -- five pins are
    five references to `pin` -- so a message that named them all `'pin'` would
    report an overlap between a part and itself. The key alone where it is
    unique, `'pin' #2` where it is not.
    """
    counts = {}
    for node in nodes:
        counts[node["key"]] = counts.get(node["key"], 0) + 1
    seen = {}
    for node in nodes:
        key = node["key"]
        if counts[key] == 1:
            node["label"] = repr(key)
            continue
        seen[key] = seen.get(key, 0) + 1
        node["label"] = f"{key!r} #{seen[key]}"


def _refuse_deformed_on_the_plate(vid, nodes):
    """The deformed hatch is shut in the `print` view, and it is a REFUSAL.

    A warning would not do, because a FILE comes out of this view. The plate is
    exported from the leaves standing in it (`assembly.export_print_plate` ->
    `print.stl`) while each part's own `<key>.stl` is exported from the
    CATALOGUE (`printables.export_printables`), so a deformed reference here
    publishes a bed carrying geometry that no downloadable part file holds --
    and nothing anywhere compares the two.

    IT IS ALSO THE WAY ROUND THE TILT GATE. `check_print_layout` reads
    `node["at"]`, so it can only judge a rigid motion; a reference handing over
    its own `shape` never goes through `at` at all, and "which way up a part
    prints is a property of the part" -- the rule that whole gate exists to
    hold -- comes off for the price of a reason string.

    And the hatch does not mean anything here in the first place. It is for a
    part that is genuinely a different shape IN PLACE -- clamped round a pipe,
    squeezed into its seat -- and a part's place on a bed is the bed. There is
    no in-place there: the part on the plate is the part.
    """
    if vid != PRINT_VIEW_ID:
        return
    bent = [node for node in nodes if node["deformed"] is not None]
    if not bent:
        return
    listed = "\n".join(f"  - {node['label']} -- {node['deformed']}"
                       for node in bent)
    raise BuildError(
        f"view {PRINT_VIEW_ID!r} carries geometry of its own:\n{listed}\n"
        'A "deformed" reference is for a part that is a different shape IN '
        "PLACE, and on a bed there is no in place -- the part on the plate is "
        f"the part. {PRINT_VIEW_ID}.stl is exported from what stands in this "
        "view and each part's own file from the catalogue, so this would "
        "publish a plate holding a shape no downloadable part has. Put the "
        "part on the bed as the catalogue holds it, and lay it out with "
        '"at".'
    )


def _warn_about_transparency(vid, nodes):
    """The three transparency warnings, and warnings is all they are.

    A part is printed exactly the same whether or not the picture of it draws
    cleanly, so nothing here may stop a build.
    """
    for node in nodes:
        alpha, label = node["alpha"], node["label"]
        if alpha <= INVISIBLE_ALPHA:
            # Not the same defect as the band below: this part is not drawn at
            # all. It passes every rule about numbers, so the only thing
            # standing between "invisible on purpose" and "invisible by a stray
            # zero" is this line -- plus the coverage gate, which does not
            # accept an invisible reference as proof that a printable is shown.
            print(
                f"warning: view {vid!r} part {label} has alpha 0, so it is not "
                "drawn at all: the picture is the same as if the part were not "
                "in the view. It is not counted as showing anything either -- "
                "a printable whose only appearance is this one is reported "
                "missing. Take the reference out if it does not belong there, "
                "or give it an alpha that can be seen."
            )
        elif NEARLY_OPAQUE_MIN <= alpha < 1.0:
            print(
                f"warning: view {vid!r} part {label} has alpha {alpha:g}, "
                "which is the worst value available: nobody can tell it from "
                "opaque, and the viewer still draws the part blended with "
                "depth writing off. Transparent objects are then sorted by the "
                "distance to their centres, and two big flat parts whose "
                "centres nearly coincide swap places as the model is turned -- "
                "a wall that appears and disappears with the angle. Make it "
                "1.0, or make it genuinely see-through (0.6 or so)."
            )
    # Every view, not just `assembled`. The renderer is the same one for all of
    # them, so a scene with nothing solid in it draws just as badly in `print`
    # or in an exploded view.
    if not any(node["alpha"] >= 1.0 for node in nodes):
        print(
            f"warning: view {vid!r} has no fully opaque part -- all "
            f"{len(nodes)} of them are transparent. A scene made only of "
            "transparent objects has nothing solid to sort against and does "
            "not draw predictably; whatever is the outside of what this view "
            "shows belongs at alpha 1.0, and only the parts you mean to look "
            "through below it."
        )


def nested_pairs(declared, keys, vid):
    """The pairs this view says are *meant* to be nested, validated.

    A part legitimately laid inside the bore of a ring is not a mistake, and a
    check that cannot be told so is a permanent red the author can only get rid
    of by deleting the check. So a view may say:

        "nested_ok": [("shim", "ring")]

    A list of PAIRS OF CATALOGUE KEYS. A flat `("shim", "ring")` is two names,
    matches nothing and would silently leave the exemption off -- so it is
    refused, and so is a key that is not one this view shows, which is the same
    mistake made with a typo.

    The shape of the list is checked by checklib, which owns that rule for
    `allowed_touching` too; only the "is this key in this view" half is left
    here, because only this file knows the answer.

    A PAIR IS TWO CATALOGUE KEYS, so one entry covers EVERY instance of that
    pair. Five references to `pin` are ten pin-against-pin box comparisons and
    `("pin", "pin")` takes the check off all ten at once. There is no way to
    exempt one reference and not another, and that follows from the shape of a
    declaration rather than from an omission: a reference has no name of its
    own to be pointed at.
    """
    try:
        allowed = checklib.name_pairs(declared, "nested_ok", f"view {vid!r}: ")
    except ValueError as exc:
        raise BuildError(str(exc)) from exc
    for pair in allowed:
        _check_pair_keys(pair, keys, vid, "nested_ok")
    return allowed


def interference_pairs(declared, keys, vid):
    """The overlaps this view says are on purpose -> `{pair: reason}`.

    Some interference is the design: a printed thread biting into its seat, a
    barb squeezing into a tube, a heat-set insert whose nominal solid is bigger
    than the hole it melts into. Those are declared, WITH A REASON, and the
    reason is the whole point of the mechanism -- an unexplained exemption is
    indistinguishable from a decoy part quietly overlapping something.

        "interference_ok": [("nozzle", "seat", "threaded joint")]

    Three elements, not two: this is deliberately NOT `checklib.name_pairs`,
    which owns the two-element shape shared with `nested_ok` and
    `allowed_touching`. A reason cannot be optional here and cannot be bolted
    onto that shape without loosening it everywhere it is used.

    A DECLARATION IS TWO CATALOGUE KEYS, so one entry covers EVERY instance of
    that pair. Five references to `pin` are ten pin-against-pin pairs and
    `("pin", "pin", "...")` takes the check off all ten at once. There is no way
    to exempt one reference and not another, and that follows from the shape of
    a declaration rather than from an omission: a reference has no name of its
    own to be pointed at. It is the same reading `nested_ok` has on the plate.
    """
    if isinstance(declared, str):
        raise BuildError(
            f"view {vid!r}: interference_ok must be a list of (part, part, "
            f"reason) triples, got the string {declared!r}."
        )
    if not hasattr(declared, "__iter__"):
        # The string above is the mistake somebody actually makes; this is
        # every OTHER thing that cannot be walked. Without it a number comes
        # out of the loop below as a bare TypeError, from a file where every
        # other refusal names what is wrong and where.
        raise BuildError(
            f"view {vid!r}: interference_ok must be a list of (part, part, "
            f"reason) triples, got {declared!r}, which cannot be iterated at "
            'all. Write it as [("nozzle", "seat", "threaded joint")].'
        )
    allowed = {}
    for index, item in enumerate(declared):
        where = f"view {vid!r}: interference_ok[{index}]"
        if isinstance(item, str) or not hasattr(item, "__iter__"):
            raise BuildError(
                f"{where} is {item!r}, not a (part, part, reason) triple. "
                'Write it as [("nozzle", "seat", "threaded joint")].'
            )
        # Once: `item` may be a generator, and a second pass over it is empty.
        items = list(item)
        if len(items) != 3 or not all(isinstance(x, str) for x in items):
            raise BuildError(
                f"{where} is {item!r}: a declaration is exactly two catalogue "
                "keys and the reason they may overlap, all three strings."
            )
        first, second, reason = items
        reason = reason.strip()
        if not reason:
            raise BuildError(
                f"{where} declares {first!r} and {second!r} may overlap and "
                "gives no reason. The reason is what separates a joint from a "
                "part standing inside another one by accident, and it is "
                "printed in the build log."
            )
        pair = frozenset((first, second))
        _check_pair_keys(pair, keys, vid, "interference_ok")
        allowed[pair] = reason
    return allowed


def _check_pair_keys(pair, keys, vid, argument):
    """Both halves of an exemption have to be parts this view actually shows."""
    unknown = sorted(x for x in pair if x not in keys)
    if unknown:
        raise BuildError(
            f"view {vid!r}: {argument} names "
            f"{', '.join(repr(x) for x in unknown)}, which is not a part this "
            f"view shows ({', '.join(repr(x) for x in sorted(keys))}). An "
            "exemption for a part that is not in the view exempts nothing; "
            "what it was written for is still unreported."
        )


def export_views(prepared, out_dir):
    """Tessellate every prepared view into its own bare-JSON file.

    Exported FLAT -- one call, every leaf, `names=` the catalogue keys -- and
    then rewritten, because the tessellator's own nesting cannot carry what
    this needs. Handed a dict it repeats the group's name a level deep
    (`/Group/housing/housing`), loses the leaf names entirely
    (`Workplane(Solid)`) and colours a group rather than the parts inside it;
    the flat call is the one that takes a name, a colour and an alpha per part.
    So the grouping is applied afterwards, on the document, where all three
    survive.

    Two things are written into the document that the tessellator does not put
    there:

      * `key` on every leaf -- the catalogue key the part came from. It is
        REDUNDANT in the sense that the leaf's name is that key already, and
        that redundancy is the point: resting on two strings being equal is the
        reconstruction this whole change removes, so the identity is stated
        rather than inferred;
      * the groups, as `{"name", "id", "loc", "parts"}` nodes. The viewer
        already understands them (`isShapeTree` is "does it have `parts`") and
        the hub already validates the nesting (`render.check_view_file`), so
        this is a shape both sides accept today -- what did not exist before is
        a build that emits it.

    Every node's `id` is rebuilt as the parent's id plus `/` plus its name,
    which is how the viewer's own paths are formed -- the leaf ids the
    tessellator wrote are for a flat document and would not match the tree.

    A MESH LEAF IS NOT HANDED OVER. There is nothing for the tessellator to do
    to a mesh -- it is triangles already -- and it takes CadQuery objects, so a
    trimesh would end the export. `shaped_document` writes those leaves itself
    and sews the two kinds back into one tree.
    """
    from ocp_tessellate.convert import export_three_cad_viewer_js

    entries = []
    for view in prepared:
        vid = view["id"]
        nodes = view["nodes"]
        solids = [node for node in nodes if node["mesh"] is None]
        filename = view["file"]
        target = out_dir / filename

        # var=None is what makes this a bare JSON document. With any other
        # value the file becomes `var shapes = {...}`, which the page cannot
        # fetch() -- and the failure is silent, an empty scene (SPEC 5.1).
        started = time.monotonic()
        export_three_cad_viewer_js(
            None, *[node["shape"] for node in solids],
            names=[node["key"] for node in solids],
            colors=[node["color"] for node in solids],
            alphas=[node["alpha"] for node in solids],
            filename=str(target),
        )
        if not target.exists():
            raise BuildError(f"tessellation produced no {filename}")
        try:
            doc = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise BuildError(
                f"{filename} is not bare JSON ({exc}); the first argument to "
                "export_three_cad_viewer_js must be None"
            ) from exc

        target.write_text(
            json.dumps(at_viewer_precision(shaped_document(doc, view))),
            encoding="utf-8")

        size = target.stat().st_size
        print(f"  {vid}: {len(nodes)} parts, {size / 1e6:.2f} MB, "
              f"{time.monotonic() - started:.1f}s")
        entries.append({
            "id": vid,
            "name": view["label"],
            "file": filename,
            # WHICH parts, not how many. A count is what this used to be, and a
            # count is the one thing meta.json must not say about references:
            # five pins are five references to one catalogue entry, and a
            # number is then a fact about the view file that disagrees with the
            # parts map next to it. Keys, deduplicated and in the order the
            # author wrote them, answer the question a reader of meta.json
            # actually has -- what is in this tab -- without fetching a
            # multi-megabyte view file to find out.
            "parts": list(dict.fromkeys(node["key"] for node in nodes)),
        })
    return entries


def shaped_document(doc, view):
    """The tessellated document with `key` stamped on and the groups put back.

    Separated from the export so the whole rewrite can be tested without a CAD
    kernel: what goes in is a JSON document and what comes out is one.

    THE TESSELLATOR SAW ONLY THE SOLID LEAVES, so its flat list lines up with
    THOSE and not with `nodes`. A per-node list is built first, taking the next
    tessellated entry for a solid leaf and writing a mesh leaf for a mesh one,
    and the tree is then rebuilt against that -- because `tree` holds indices
    into `nodes`, and a mesh leaf anywhere but the end would otherwise shift
    every later solid leaf onto the wrong key, permanently, into an immutable
    build.
    """
    flat = doc.get("parts")
    nodes = view["nodes"]
    solids = [node for node in nodes if node["mesh"] is None]
    if not isinstance(flat, list) or len(flat) != len(solids):
        # The tessellator is handed one object per solid leaf and hands back one
        # entry per object. If that ever stops being true the stamping below
        # would file parts under the wrong keys -- silently, and permanently,
        # into an immutable build.
        raise BuildError(
            f"view {view['id']!r} tessellated into "
            f"{len(flat) if isinstance(flat, list) else type(flat).__name__} "
            f"parts, and {len(solids)} of the view's {len(nodes)} leaves were "
            "handed over. The two have to line up: the key of each part is "
            "taken from the view by position."
        )

    leaves = []
    supplied = iter(flat)
    repeats = {}
    for node in nodes:
        if node["mesh"] is None:
            leaf = next(supplied)
            leaf["key"] = node["key"]
            leaves.append(leaf)
            continue
        repeats[node["key"]] = repeats.get(node["key"], 0) + 1
        leaves.append(_mesh_leaf(node, repeats[node["key"]]))

    def rebuild(entries, parent_id):
        built = []
        for entry in entries:
            if isinstance(entry, int):
                leaf = leaves[entry]
                # The name is the tessellator's rather than the key: it
                # disambiguates repeats of one name (`pin`, `pin(2)`), and the
                # viewer builds its paths out of names, so two leaves called
                # the same thing would share a path. A mesh leaf was named the
                # same way by `_mesh_leaf`, which is the whole reason it counts
                # its own repeats.
                #
                # DEMANDED RATHER THAN DEFAULTED, for the reason the length of
                # `flat` is checked above: this rests on what the tessellator
                # writes, and `leaf.get("name")` would turn a document that
                # stopped carrying one into a tree of leaves all called
                # `/Group/None` -- every path identical, every part
                # indistinguishable in the viewer, published into an immutable
                # build with nothing anywhere saying so.
                name = leaf.get("name")
                if not isinstance(name, str) or not name:
                    raise BuildError(
                        f"view {view['id']!r}: the tessellator gave a part no "
                        f"usable name ({name!r}). Every node's id is built as "
                        "the parent's plus its name, so a part without one has "
                        "no path of its own and the viewer cannot tell it from "
                        "its neighbours."
                    )
                leaf["id"] = f"{parent_id}/{name}"
                built.append(leaf)
                continue
            node = {"version": doc.get("version"), "name": entry["group"],
                    "id": f"{parent_id}/{entry['group']}",
                    # The group does not move anything: it is a row in the
                    # tree, and every leaf under it already stands where the
                    # view put it. The identity location is written out
                    # because the viewer reads `loc` off every node it renders.
                    "loc": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]],
                    "parts": []}
            node["parts"] = rebuild(entry["parts"], node["id"])
            built.append(node)
        return built

    # THE ROOT ID IS DEMANDED for the same reason a leaf's name is, and it is
    # the other end of the same string: every node's id is `<parent>/<name>`,
    # and the first parent is this. `doc.get("id")` would build the whole tree
    # under `None/...` -- `render.check_view_file` on the hub does not look at
    # an id, so that publishes into an immutable build in silence, and every
    # path the viewer makes out of it is wrong from its first character.
    root_id = doc.get("id")
    if not isinstance(root_id, str) or not root_id:
        raise BuildError(
            f"view {view['id']!r}: the tessellated document carries no usable "
            f"id ({root_id!r}). It is the root of every path in the view -- "
            "each node's id is the parent's plus its name -- so without one "
            "the whole tree hangs off a name that is not there."
        )
    doc["parts"] = rebuild(view["tree"], root_id)
    _widen_bb(doc, nodes)
    return doc


def _mesh_leaf(node, occurrence):
    """One leaf written from a trimesh, field for field as a tessellated one.

    The field set is `ocp_tessellate.cad_objects`' own (a solid leaf of
    `ui/tests/fixtures/assembled.json` is what it looks like), because the
    viewer reads every one of them off every node it draws. What a mesh has
    none of is TOPOLOGY -- no edges, no vertices to snap to, no faces to count
    triangles per -- so those buffers are written EMPTY rather than invented:
    the viewer draws a leaf without edges (`viewer/src/scene/nestedgroup.ts`
    guards on `edgeList && edgeList.length > 0`), and a made-up edge would be a
    line nobody modelled.

    THE NAME IS NUMBERED THE WAY THE TESSELLATOR NUMBERS ONE -- `scan`, then
    `scan(2)` -- because every node's id is the parent's plus its name, so two
    references to one mesh under one name would share a path and neither the
    viewer nor a reader could tell them apart. Counting only the mesh
    occurrences of that key is enough: a catalogue entry is a mesh or a solid
    and never both, AND a reference to a mesh one cannot come out a solid leaf
    -- `_read_reference` refuses the `deformed` hatch over a mesh -- so the two
    numberings cannot meet on one name. The second half is the load-bearing
    one: entry-level exclusivity alone let a mesh entry produce a solid leaf,
    which is exactly how the two numberings used to meet.

    The identity `loc` is written out in full, like the one on a group above,
    because the viewer reads `loc` off every node it renders -- and it IS the
    identity because the mesh is already where the model put it:
    `_read_reference` refuses `at` on one.
    """
    import numpy as np

    mesh = node["mesh"]
    triangles = np.asarray(mesh.faces).reshape(-1)
    return {
        "type": "shapes",
        "subtype": "solid",
        "name": node["key"] if occurrence == 1
                else f"{node['key']}({occurrence})",
        "shape": {
            "vertices": np.asarray(mesh.vertices,
                                   dtype=np.float64).reshape(-1).tolist(),
            "normals": np.asarray(mesh.vertex_normals,
                                  dtype=np.float64).reshape(-1).tolist(),
            "triangles": triangles.tolist(),
            "edges": [],
            "obj_vertices": [],
            "face_types": [],
            "edge_types": [],
            "segments_per_edge": [],
            # ONE ENTRY, the whole mesh: the viewer walks this buffer to split
            # the triangles into faces it can pick, and a mesh is one face's
            # worth of triangles because it has no faces to be several.
            "triangles_per_face": [len(triangles) // 3],
        },
        "state": [1, 1],
        "color": node["color"],
        "alpha": node["alpha"],
        "material": None,
        "normalize_uvs": True,
        "texture": None,
        "loc": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]],
        "renderback": False,
        "accuracy": None,
        "bb": None,
        "key": node["key"],
    }


def _widen_bb(doc, nodes):
    """Take the meshes into the root's box, which nothing else in the build does.

    The tessellator measures what it was GIVEN and a mesh leaf never reaches it,
    so the box it wrote is the box of the solids alone. The viewer reads the
    scene's extent exactly once and only off the root
    (`comparescene._union_bb` has that measurement), so a mesh outside that box
    is drawn off screen with the camera framed on the parts beside it -- a scene
    that looks like a missing mesh rather than like a bad box.

    A VIEW OF NOTHING BUT MESHES HAS NO BOX TO WIDEN: handed no objects at all
    the tessellator writes `"bb": null`, so the meshes are the whole of it.
    """
    bounds = [node["mesh"].bounds for node in nodes if node["mesh"] is not None]
    if not bounds:
        return
    lows = [[float(value) for value in box[0]] for box in bounds]
    highs = [[float(value) for value in box[1]] for box in bounds]
    box = doc.get("bb")
    if isinstance(box, dict):
        lows.append([float(box[f"{axis}min"]) for axis in BB_AXES])
        highs.append([float(box[f"{axis}max"]) for axis in BB_AXES])
    widened = {}
    for index, axis in enumerate(BB_AXES):
        widened[f"{axis}min"] = min(low[index] for low in lows)
        widened[f"{axis}max"] = max(high[index] for high in highs)
    doc["bb"] = widened


def at_viewer_precision(doc):
    """The same document with every coordinate cut down to what float32 keeps.

    The viewer loads each mesh buffer into a `Float32Array`
    (`viewer/src/scene/nestedgroup.ts`), so every digit a coordinate carries
    beyond float32 is thrown away the moment it arrives -- shipped over the
    wire and then dropped on the floor. Writing the shortest decimal that reads
    back as the same float32 takes a third off the document (6.65 MB -> 4.27 MB
    on an 82k-triangle mesh, 2.60 -> 1.49 gzipped) and moves nothing that is
    drawn.

    Only the float buffers: the integers beside them (`triangles`,
    `face_types`, `edge_types`, `triangles_per_face`, `segments_per_edge`) are
    indices, counts and OCP type codes, and the viewer reads them into a
    `Uint32Array`.

    Pure JSON in, JSON out, like `shaped_document` above it, so what it does is
    testable without a CAD kernel.
    """
    import numpy as np

    def shortest(values):
        # numpy prints a float32 as the shortest decimal that reads back as
        # that same float32, which is what makes this lossless against the
        # buffer the browser ends up with. Whole-array rather than a loop: the
        # numbers in one view are counted in the hundreds of thousands.
        return (np.asarray(values, dtype=np.float64).astype(np.float32)
                .astype(str).astype(np.float64).tolist())

    def shorten(node):
        for child in node.get("parts", ()):
            shorten(child)
        # A group carries no `shape`; every leaf does.
        shape = node.get("shape")
        if not shape:
            return
        for name in ("vertices", "normals", "obj_vertices"):
            if shape.get(name):
                shape[name] = shortest(shape[name])
        # A segment at a time: `edges` is a list of them and the viewer
        # flattens it itself, so the nesting has to come out as it went in.
        if shape.get("edges"):
            shape["edges"] = [shortest(edge) for edge in shape["edges"]]

    shorten(doc)
    return doc
