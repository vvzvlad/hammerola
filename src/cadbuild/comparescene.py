#!/usr/bin/env python3
"""Two revisions in ONE scene: both shells neutral and see-through, the difference bright.

Issue #10 asks WHERE a revision changed, and the answer is a picture rather than
a number: revision A and revision B drawn translucent in one neutral colour, and
the material the change added and took away drawn bright on top of them, all in
one window. This module assembles that one payload and does nothing else --
there is no route here, no job, no subprocess and no CLI. `shapediff.measure`
says what the difference IS; this says where it is.

NEITHER REVISION IS TESSELLATED HERE. Both arrive as the view documents their
own builds already exported (`views.export_views`), parsed from JSON, and what
happens to them is a RE-LABELLING: every id rebuilt under its revision's prefix,
every leaf recoloured to the neutral shell. The only geometry that turns into
triangles here is the difference a fuse MEASURED, which nothing has ever
tessellated before -- a part only one of the two revisions has is difference
geometry in its whole, and it is re-labelled like everything else rather than
tessellated again -- and it is the cheap third of the answer: 1.49 s for a real
pair, measured in issue #10 as 0.33 s reading the two STEP files, 0.86 s fusing
them and 0.30 s tessellating what came out.

THE PREFIXES ARE NOT COSMETIC. Merging two documents without rebuilding their
ids does not raise -- it silently LOSES the parts whose paths collide. Measured
in the browser: 5 parts in, 3 leaves in the tree, 5 objects in the scene, and
the duplicate is drawn, eats a frame, and is addressable by nothing. It cannot
be hidden, recoloured or cut, and highlighting its path lights both copies.

THE DIFFERENCE IS MEASURED IN THE PART'S OWN COORDINATES and has to be put back
where the part stands. A build exports one STEP per printable straight out of
the catalogue entry (`printables.export_printables` exports `catalogue[key]
["shape"]`), which is the part unmoved, while its place in a view is the `loc`
of the leaf that references it. So every piece of difference geometry is drawn
with the loc of the leaf it belongs to; without that it lands at the origin,
which looks like a scene rather than like a defect.

REFUSALS HERE ARE `ValueError` AND NOT `BuildError`, and the line is which side
the fault is on: nothing in this file runs a model. What it reads is a DOCUMENT
that already exists, so a document it cannot merge is the same kind of news as
one the hub cannot serve (`render.check_view_file`), not a build that failed.

Every import that costs anything is inside the function that needs it, like the
rest of this package: `report` is arithmetic over dicts and has to run where
there is no kernel at all -- in CI (issue #27), and in every test of what the
hub will say about a pair of revisions.
"""

import json


__all__ = [
    "ADDED_COLOR",
    "ADDED_NAME",
    "DIFFERENCE_ALPHA",
    "REMOVED_COLOR",
    "REMOVED_NAME",
    "REVISION_A_NAME",
    "REVISION_B_NAME",
    "ROOT_NAME",
    "SHELL_ALPHA",
    "SHELL_COLOR",
    "STATUSES",
    "build_scene",
    "report",
]


# The five names the scene is addressed BY, and they are a contract with the
# browser rather than a preference: the interface hides and shows a revision by
# matching the id prefix `/cmp/rev a` or `/cmp/rev b`. They are the names the
# prototype in issue #10 was measured with, and renaming one silently leaves the
# interface matching nothing -- which is a scene where the toggles do nothing.
ROOT_NAME = "cmp"
REVISION_A_NAME = "rev a"
REVISION_B_NAME = "rev b"
REMOVED_NAME = "removed"
ADDED_NAME = "added"

# The palette, decided and measured in issue #10 and colourblind-safe.
#
# THERE IS NO INDUSTRY CONVENTION TO FOLLOW: green-is-added in GitHub, NX and
# AutoCAD, the other way round in CATIA, and in metrology (GOM, Geomagic) red
# means EXCESS material. The one thing every tool agrees on is that the
# unchanged is muted rather than coloured, so the legend is compulsory -- it is
# the browser's, and this module only has to hold to the colours it names.
SHELL_COLOR = "#7a8fa6"
SHELL_ALPHA = 0.18
REMOVED_COLOR = "#d1495b"
ADDED_COLOR = "#2a9d5c"

# OPAQUE IS LOAD-BEARING and not a matter of taste. Sorting of transparent
# objects is per-object, by the centre of the bounding sphere, so the two shells
# swap places on a slow rotation; the bright layer is stable through that
# because an opaque object WRITES DEPTH, and the flicker behind it is masked by
# both shells being one colour.
DIFFERENCE_ALPHA = 1.0

# What `report` may say about a part, and the whole of it.
#
# `not measured` IS A VERDICT AND NOT AN ABSENCE OF ONE. It is spelled the way
# the printed report spells it (`buildproc.comparechild`), because a reader
# meets the two side by side -- the job log and the panel over the same pair of
# revisions -- and one of them inventing its own word for the same thing is
# exactly the drift both halves are written to avoid. Folding it into
# `unchanged` was the defect this status replaced: `shapediff.check` refuses a
# measurement precisely where the kernel may have lied, and publishing that
# refusal as "no difference" is the most confident possible answer given to the
# one question nothing could answer.
#
# THE TWO SILENCES ARE TWO WORDS, and one word for both was the defect after
# that one. `not measured` is the ALARMING silence and only that: the gate
# turned a measurement down, or the part's file could not be read at all --
# something is wrong here and the reader has to see it first. `not compared` is
# the ROUTINE one: the two builds did not both export this part as STEP, so no
# pair of solids was ever put together. Most of those are `hardware` and `mock`
# entries, which have no geometry of ours in either revision and which nobody
# compares -- and some are a part that changed KIND between the two revisions,
# where one build did export a STEP and the other had nothing to fuse it with.
# Nothing is wrong with such a part; it is a property of the pair rather than an
# event in this revision, and most models have several. Under one word the
# routine case pushed the actual answer -- what CHANGED -- below a stack of rows
# saying nothing happened and nothing could have.
#
# WHAT THE TWO SHARE IS THE ONE THING NEITHER MAY DO: be dressed up as
# `unchanged`, or counted into a summary that says the two revisions came out
# identical. Nobody looked, so nothing may be claimed.
STATUSES = ("unchanged", "changed", "new", "removed", "not measured",
            "not compared")

# The `loc` of a node that moves nothing: no translation, unit quaternion. It is
# what the scene root carries (the two revisions are already where their own
# documents put them) and what a freshly tessellated difference piece has to
# carry before it is placed.
IDENTITY_LOC = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]

# The six numbers a bounding box is, in the spelling the viewer reads them in.
BB_FIELDS = ("xmin", "ymin", "zmin", "xmax", "ymax", "zmax")


def build_scene(document_a, document_b, diffs, *, view_id):
    """One payload the viewer's own `render()` takes, out of two published views.

    `document_a` and `document_b` are the two revisions' view documents for the
    SAME view, already parsed from JSON. `diffs` is `{catalogue key:
    measurement}` as `shapediff.measure(..., keep_shapes=True)` returns them --
    gated by `check` and filtered by `drop_slivers` first, both of which are the
    caller's to run: a piece thinner than the kernel's own noise must no more be
    drawn than reported. `view_id` names the view in every refusal below.

    WHAT IS COMPARED IS THE VIEW, and `report` beside it holds to the same rule.
    A part BOTH views show is compared piece by piece out of `diffs`; a part
    only one of them shows is difference geometry in its ENTIRETY -- all of it
    appeared, or all of it went -- and is drawn from its own leaf (`_whole`). A
    measurement of the two STEP files behind such a part says how the PART
    changed, which is not what this view gained or lost, so it is not drawn:
    `report` calls that part new or removed, and the picture says the same.

    The result is one root group with exactly four children, in this order:
    revision A, revision B, the material removed, the material added.
    """
    root_id = f"/{ROOT_NAME}"
    shell_a, places_a = _revision(document_a, REVISION_A_NAME, root_id, view_id)
    shell_b, places_b = _revision(document_b, REVISION_B_NAME, root_id, view_id)

    # WHAT BOTH VIEWS SHOW, by the one rule `report` reads them with. The split
    # it makes is exhaustive and has no overlap: every place is either compared
    # or drawn whole, so no leaf can end up with two nodes on one path.
    common = _shown(document_a, view_id) & _shown(document_b, view_id)

    # Each side is placed by ITS OWN revision's document: what was removed was
    # part of A and stands where A shows that part, what was added is part of B.
    plan = (_planned(places_a, diffs, common, "removed", REMOVED_NAME,
                     REMOVED_COLOR, view_id)
            + _planned(places_b, diffs, common, "added", ADDED_NAME,
                       ADDED_COLOR, view_id))
    drawn, tessellated_version = _drawn(plan, view_id)

    # A WHOLE PART IS A DIFFERENCE TOO, and it costs nothing to draw: the
    # geometry is the leaf that is already in the document being re-labelled,
    # so this adds no work at all to the plan above.
    drawn[REMOVED_NAME] += _whole(places_a, common, REMOVED_COLOR)
    drawn[ADDED_NAME] += _whole(places_b, common, ADDED_COLOR)

    seen = {REVISION_A_NAME: document_a.get("version"),
            REVISION_B_NAME: document_b.get("version")}
    if plan:
        seen["the difference"] = tessellated_version
    version = _one_version(seen, view_id)

    return {
        "version": version,
        "name": ROOT_NAME,
        "id": root_id,
        "loc": IDENTITY_LOC,
        # Copied rather than computed: the viewer never reads it (measured --
        # the vendored bundle has no `normal_len` in it at all), and the two
        # documents are written by one exporter, so A's is the scene's.
        "normal_len": document_a.get("normal_len", 0),
        "bb": _union_bb(document_a, document_b, view_id),
        "parts": [
            shell_a,
            shell_b,
            _group(REMOVED_NAME, root_id, version, drawn[REMOVED_NAME]),
            _group(ADDED_NAME, root_id, version, drawn[ADDED_NAME]),
        ],
    }


def report(diffs, document_a, document_b, *, view_id, refused, covered):
    """What changed, per part and in total, as a plain JSON-able dict.

    `{"parts": [{"key", "status", "added_mm3", "removed_mm3"}, ...], "totals":
    {"added_mm3", "removed_mm3"}}`, with `status` one of `STATUSES` and nothing
    else, and one `reason` besides on the rows nobody measured -- the two words
    for that, `not measured` and `not compared`, and no others. Arithmetic over
    dicts and set membership -- no kernel, no OCP import, no geometry -- because
    this is the half that has to run where `build_scene` cannot.

    `refused` IS `{catalogue key: reason}` FOR THE PARTS NOBODY COULD MEASURE,
    as `buildproc.comparechild` collected them, and it is DEMANDED rather than
    defaulted for the reason `_demanded` gives about the fields it demands: a
    caller who forgets it gets no error at all, just every refusal published as
    `unchanged` -- which is the defect this argument was added to end. An empty
    mapping is the ordinary case and says so.

    `covered` IS THE SET OF KEYS THE WALK ACTUALLY COMPARED, as
    `buildproc.comparechild._compare` returns it, and it is DEMANDED for the
    same reason one level up: `unchanged` is said here only about a key that IS
    in it, so a caller who forgets the argument publishes a whole view as
    unchanged. THE WALK IS OVER `*.step` FILES AND A BUILD EXPORTS ONE PER
    PRINTABLE (`cadbuild.printables`), while a view's leaves are every kind of
    catalogue entry -- so every `hardware` and every `mock` a view shows is a
    key no measurement ever looked at, and reading its absence from `diffs` as
    "no difference" was the defect this argument ends. A part only one of the
    two builds exported is out of it too: nothing fused anything, so nothing was
    established about how that part changed.

    THE PARTS ARE THE ONES THE TWO VIEWS SHOW, read out of the same two
    documents the scene is built from and by the same rule (`_shown`), which is
    what makes the list and the picture one statement: a part this view does not
    show has no shell, no bright geometry and no row, and a part only one of the
    two revisions shows is `new` or `removed` in both. Listed from what the
    builds EXPORTED instead -- every printable in the catalogue -- the two would
    contradict each other over a part kept in the catalogue and dropped from
    this view, and the panel would carry rows a reader cannot click through to.

    THE PRINTED REPORT IS A DIFFERENT QUESTION and still answers it in full:
    `buildproc.comparechild` walks every `*.step` of the two builds and names
    the parts no view shows. Its stdout is untouched by this.

    A LIST AND NOT A MAP, with the key INSIDE each row, because that is what the
    browser reads: `compareRows` in ui/src/HammerolaViewer.jsx takes
    `report.parts` as an array and drops any row without a string `key`. A map
    there is not an error on either side -- it is a panel that says "this report
    lists no parts" over a comparison that found plenty.

    SORTED BY KEY, which is the order the printed report walks its own parts in
    (`buildproc.comparechild` compares `sorted(set(old) | set(new))`), so the two
    accounts list the parts they share alike. The browser sorts what changed to
    the top with a STABLE sort, so this is the order that survives inside each
    half of its list.

    A KEY BOTH VIEWS SHOW IS UNCHANGED ONLY WHERE THE WALK COVERED IT and
    neither map holds it: that is the digest fast path, where two STEP files are
    equal byte for byte and there was nothing for the kernel to do -- and it is
    equally the part whose measurement found nothing, or nothing but slivers,
    since the caller keeps only what it called changed. A key the walk did NOT
    cover has none of that behind it: nothing looked at the part, so the row
    says `not compared` and carries the reason why (`_uncovered_line`) instead
    of the confident word. That is the rule, and not a list of the ways a key
    can be in neither map: `unchanged` is concluded from a membership and never
    from an absence.

    A KEY IN `refused` IS `not measured` AND CARRIES THE REASON IT WAS GIVEN.
    Nothing is drawn bright for such a part -- there are no pieces to draw, and
    the scene is right to show none -- but the two accounts are still one
    statement, because the row says what the job log says on the same part's
    line rather than the opposite of it. A part only one of the two views shows
    is `new` or `removed` first: what this view gained or lost is the whole
    part, whatever a fuse over the two STEP files did or did not manage.

    THE VOLUMES ARE THE PIECES' OWN and not the measurement's totals, so that
    this report and the scene beside it are one statement. `drop_slivers`
    deliberately leaves `removed_mm3` as measured -- the gate's identities are
    sums over EVERY piece -- so a part whose only difference was noise still
    carries a number there, and reading it here would report a part as unchanged
    and give a volume for the change in the same line.

    A part only one of the two views shows counts as no material either way.
    Either nothing fused it against anything, or -- where both revisions did
    export it -- what a fuse measured is the difference between two versions of
    the PART, and not the material this view gained or lost, which is the whole
    of it. The number that would be honest, the volume its own build recorded,
    is in that revision's metrics.json: the text half's to read
    (`buildproc.comparechild`) and not this module's.
    """
    in_a, in_b = _shown(document_a, view_id), _shown(document_b, view_id)
    parts = []
    for key in sorted(in_a | in_b):
        if key not in in_a:
            parts.append(_line(key, "new"))
        elif key not in in_b:
            parts.append(_line(key, "removed"))
        elif key in refused:
            parts.append(_refused_line(key, refused[key]))
        elif key not in covered:
            # AHEAD OF `diffs`, so no value can talk this row into a verdict:
            # what decides here is whether anything measured this part at all,
            # the same way the walk routes by its verdict and not by what came
            # back (`comparechild._compare`).
            parts.append(_uncovered_line(key))
        else:
            parts.append(_measured_line(key, diffs.get(key)))
    return {
        "parts": parts,
        "totals": {
            "added_mm3": sum((line["added_mm3"] for line in parts), 0.0),
            "removed_mm3": sum((line["removed_mm3"] for line in parts), 0.0),
        },
    }


def _line(key, status, added_mm3=0.0, removed_mm3=0.0):
    return {"key": key, "status": status, "added_mm3": added_mm3,
            "removed_mm3": removed_mm3}


def _refused_line(key, reason):
    """The line for a part something went wrong on, and what went wrong.

    THE ALARMING SILENCE AND ONLY IT: the gate turned the measurement down --
    `shapediff.check` refuses precisely where the kernel may have lied -- or the
    part's file could not be read at all. Either way this pair of revisions has
    a question outstanding on this part, and the reader has to meet it before
    anything else. The routine silence, a part no build exports as STEP, is
    `_uncovered_line` and a quieter word.

    NO VOLUMES ON IT, the same zeroes `new` and `removed` carry: what a refused
    measurement holds is a reason and nothing that may be added up. The reason
    rides along because it is the only content of this row -- "not measured"
    alone tells a reader that something is wrong and not what, while the job log
    beside it has had the sentence all along (`buildproc.comparechild`).
    """
    return dict(_line(key, "not measured"), reason=reason)


def _uncovered_line(key):
    """The line for a part in the view that no measurement ever looked at.

    NOT THE GATE'S WORD, AND THAT IS THE WHOLE POINT OF THIS ROW. Nothing is
    wrong here: nobody compares bought screws, and a `hardware` entry having no
    geometry of ours is a property of the part rather than an event in this
    revision. Under the gate's word it wore the warning colour and sat at the
    top of the list, and since most models carry several bought parts, that
    stack of rows -- every one of them saying nothing happened and nothing could
    have -- stood between the reader and the parts that DID change.

    STILL NEVER `unchanged`, for the reason it never was. Swap an M3x8 for an
    M3x12 and nothing here can see it, so the row says nobody looked rather than
    letting the panel say "identical".

    THE VIEW AND THE WALK ARE DIFFERENT SETS, which is why this row exists at
    all. A build exports one STEP per PRINTABLE and the walk is over those
    files; a view's leaves are every kind of catalogue entry (`parts.KINDS`), so
    a `hardware` or a `mock` the view shows is a part the walk never had.

    THE SENTENCE DEFINES THE CATEGORY AND THEN GIVES THE EXAMPLE, and that
    order is the fix rather than the phrasing. It said hardware and mocks have
    no geometry of ours to compare, which is true of nearly every row that
    carries it and false of the one worth writing a sentence for: a part that
    was `printable` in one revision and hardware, or a mock, in the other is
    also uncovered -- the walk called it `new` or `removed` and left it out of
    `covered` -- and THERE one build did export a STEP. What holds for the whole
    category is that no PAIR of STEP files came from the two builds, so nothing
    was fused. The browser's legend says the same thing in the same order
    (`NOT_COMPARED_WHY` in ui/src/HammerolaViewer.jsx), because the reader meets
    the two as one explanation.
    """
    return dict(_line(key, "not compared"),
                reason="the two builds did not both export it as STEP, so "
                       "nothing was fused -- hardware and mocks most often")


def _measured_line(key, measurement):
    """The line for a part both revisions have and the gate vouched for.

    A part the gate REFUSED never reaches this: `report` sends it to
    `_refused_line` by its key, and one the walk never covered to
    `_uncovered_line` by the same rule. What is left for `None` here is a part
    the walk DID measure and kept nothing about -- equal bytes, or a fuse that
    found nothing worth keeping -- which is unchanged.
    """
    if measurement is None:
        return _line(key, "unchanged")
    # Indexed and never `.get`: a measurement `check` refused carries ONLY
    # `reason`, and KeyError on it here is the contract `drop_slivers` already
    # holds -- the gate runs before this, never after. Defaulted instead, a pair
    # the kernel could not measure would be reported as unchanged.
    removed, added = measurement["removed"], measurement["added"]
    status = "changed" if (removed or added) else "unchanged"
    return _line(key, status,
                 sum((piece["volume_mm3"] for piece in added), 0.0),
                 sum((piece["volume_mm3"] for piece in removed), 0.0))


def _shown(document, view_id):
    """The catalogue keys a view document references, once each.

    THE ONE ANSWER TO "WHICH PARTS IS THIS VIEW ABOUT", and both halves of a
    comparison read it: the scene decides by it which parts to compare and which
    to draw whole, the report decides by it which parts to list. One function
    and not two readings, so the picture and the list cannot drift into
    describing different sets of parts -- which is the bug this replaced, a part
    kept in the catalogue and dropped from this view being bright in one and
    unchanged in the other.

    A key appears ONCE however many times the view references it: `pin` and
    `pin(2)` are one catalogue entry standing in two places (issue #75). This
    answers which parts; `_revision` answers where each of them stands.

    The group rule is `"parts" in node`, the viewer's own, for the reason
    `_toned` gives.
    """
    keys = set()
    _gather(document, keys, view_id)
    return keys


def _gather(node, keys, view_id):
    if "parts" in node:
        for child in node["parts"]:
            _gather(child, keys, view_id)
        return
    keys.add(_demanded(node, "key", node.get("id"), view_id))


def _revision(document, name, root_id, view_id):
    """The revision's whole document, re-rooted under the scene and toned down.

    Returns `(group, places)`: the node to hang under the scene root, and where
    every part it shows stands -- key, leaf name, loc, and the toned leaf
    itself. ONE WALK for all of it, because they are the same fact: the loc a
    difference piece is drawn with is the loc of the very leaf this recolours,
    and for a part the other revision does not have, that leaf IS the
    difference (`_whole`).

    The document's own root becomes the revision's group, so a part that was
    `/Group/front` in the published view is `/cmp/rev a/front` here: one prefix
    per revision, which is what keeps the two sets of paths apart.

    NOTHING PASSED IN IS MODIFIED -- every node is copied before it is changed,
    because the caller holds these documents and may hand them to something else
    afterwards. The MESH under a leaf is shared rather than copied: it is the
    biggest thing in the document by orders of magnitude, nothing here writes to
    it, and it is serialised out by value when the scene is written.
    """
    places = []
    return _toned(document, name, root_id, view_id, places), places


def _toned(node, name, parent_id, view_id, places):
    """One node of a revision: copied, re-ided, and greyed out if it is a leaf."""
    copy = dict(node)
    copy["name"] = name
    copy["id"] = f"{parent_id}/{name}"
    copy["loc"] = _demanded(node, "loc", copy["id"], view_id)

    # `"parts" in node` is the viewer's own rule for what a group is
    # (`isShapeTree(shape) { return "parts" in shape; }`), and the hub reads a
    # document the same way (`render.check_view_file`). Asking anything else --
    # `is None`, truthiness -- puts this and the browser on different answers
    # about the same node, which is how `{"parts": null}` once got published.
    if "parts" in node:
        copy["parts"] = [
            _toned(child, _demanded(child, "name", copy["id"], view_id),
                   copy["id"], view_id, places)
            for child in node["parts"]]
        return copy

    copy["color"] = SHELL_COLOR
    copy["alpha"] = SHELL_ALPHA
    # The leaf goes on the place beside its loc: for a part only this revision
    # has, it is the difference geometry itself and not merely where it stands.
    # Copied again before it is recoloured there, so the shell stays neutral.
    places.append({"key": _demanded(node, "key", copy["id"], view_id),
                   "name": name, "loc": copy["loc"], "leaf": copy})
    return copy


def _demanded(node, field, where, view_id):
    """A field the scene cannot be built without, or the sentence saying so.

    DEMANDED RATHER THAN DEFAULTED, all three of them, for the reason
    `views.shaped_document` demands the two it demands: what a missing one
    produces is not an error but a WRONG SCENE, drawn and looking fine.

      * no `name` -- every node under it shares one path, and neither the viewer
        nor the interface can tell one part from another;
      * no `loc` -- the part, and the bright geometry drawn on it, stands at the
        origin instead of where the view puts it;
      * no `key` on a leaf -- there is nothing to match a measured difference
        to, so that part quietly loses its difference geometry while every other
        part keeps its own.
    """
    # Emptiness and absence are one case here: a name of `""` builds the same
    # colliding path a missing one does, and a `loc` of `[]` is as much nowhere
    # to stand as no `loc` at all.
    value = node.get(field)
    if not value:
        raise ValueError(
            f"view {view_id!r}: the node {where!r} of the comparison scene "
            f"carries no {field!r} ({value!r}). Every node of the two documents "
            "merged here has to have one -- without it this draws a scene that "
            "is wrong rather than one that fails.")
    return value


def _planned(places, diffs, common, side, group_name, color, view_id):
    """Every piece of one side, once per place the part it belongs to stands in.

    ONLY FOR A PART BOTH VIEWS SHOW (`common`). A measurement says how two
    versions of one part differ; where the other revision's view does not show
    that part at all, the difference this view has is the WHOLE part, and
    `_whole` draws it. Sharing the places out between the two rather than
    letting both draw is also what keeps one leaf from getting two nodes on one
    path.

    ONCE PER PLACE and not once per part: a view references the catalogue, and
    one entry may be referenced many times (`pin` x5, issue #75), each
    occurrence its own leaf with its own loc. A part that changed changed at
    every one of them.

    A key in `diffs` this view does not show is SKIPPED, and that is ordinary
    rather than a failure: a view shows a subset of the catalogue, while the
    STEP files a build exports are every printable in it.
    """
    planned = []
    for place in places:
        if place["key"] not in common:
            continue
        measurement = diffs.get(place["key"])
        if measurement is None:
            continue
        # Indexed for the reason `_measured_line` is: a refused measurement has
        # no lists at all, and the gate belongs in front of this.
        for index, piece in enumerate(measurement[side], start=1):
            if "shape" not in piece:
                raise ValueError(
                    f"view {view_id!r}: the difference measured for "
                    f"{place['key']!r} has no shape to draw. "
                    "`shapediff.measure(..., keep_shapes=True)` is what puts "
                    "one on each piece; the default keeps two floats and throws "
                    "the solids away.")
            planned.append({
                "group": group_name,
                "color": color,
                # The leaf's name and not the catalogue key: the key is repeated
                # across occurrences (`pin`, `pin(2)`) and every node here needs
                # a path of its own. The index disambiguates the pieces of one
                # part, which a boolean produces several of routinely -- a vent
                # slot widened by 0.4 mm came out as 12 of them.
                "name": f"{place['name']} #{index}",
                "key": place["key"],
                "loc": place["loc"],
                "shape": piece["shape"],
            })
    return planned


def _whole(places, common, color):
    """Every part this view shows and the other revision's does not, drawn entire.

    A part only one of the two views shows is difference geometry in its whole:
    all of it appeared, or all of it went. Without this it reaches the scene as
    a neutral translucent shell inside its own revision and nothing else --
    indistinguishable, on screen, from geometry nobody touched -- while `report`
    calls it `new` or `removed`. This is the picture saying the same thing.

    A MEASUREMENT OF SUCH A PART IS NOT DRAWN, and `_planned` is the half that
    leaves it alone. Where both revisions exported the part, a fuse can measure
    how the part changed, but this view did not gain or lose those pieces -- it
    gained or lost the part.

    NOTHING IS TESSELLATED HERE. The leaf the revision published is already
    triangles, already in the frame its own `loc` moves, and already carries
    the catalogue key -- so the bright copy is that leaf with the two fields
    that make it bright, the same pair `_drawn` stamps on a fused piece. The
    neutral shell stays where it is: the bright copy is opaque and writes
    depth, so it wins where the two overlap, which is the arrangement the fused
    pieces already rely on.

    ONCE PER PLACE, for the reason `_planned` is: one catalogue entry may be
    referenced many times (`pin`, `pin(2)`), each occurrence its own leaf with
    its own loc, and a part that appeared appeared at every one of them.

    """
    bright = []
    for place in places:
        if place["key"] in common:
            continue
        leaf = dict(place["leaf"])
        # Numbered like a measured piece (`body #1`), because a whole part is
        # the first and only piece of its own difference: one naming scheme for
        # every leaf in these two groups, and one for a reader to learn.
        leaf["name"] = f"{place['name']} #1"
        leaf["color"] = color
        leaf["alpha"] = DIFFERENCE_ALPHA
        bright.append(leaf)
    return bright


def _drawn(plan, view_id):
    """The planned pieces, tessellated and placed. `({group: [leaf]}, version)`."""
    drawn = {REMOVED_NAME: [], ADDED_NAME: []}
    if not plan:
        # Nothing changed anywhere in this view -- which is a legitimate answer
        # and not a reason to hand the tessellator an empty argument list.
        return drawn, None

    flat, version = _tessellate(plan)
    if not isinstance(flat, list) or len(flat) != len(plan):
        # One object in, one entry back, and everything below is aligned BY
        # POSITION -- the same rest `views.shaped_document` checks, and the same
        # failure if it ever stops holding: pieces drawn under the wrong part.
        raise ValueError(
            f"view {view_id!r}: the tessellator was handed {len(plan)} pieces "
            f"of difference geometry and gave back "
            f"{len(flat) if isinstance(flat, list) else type(flat).__name__}. "
            "Each piece is placed by its position in that list.")

    for leaf, entry in zip(flat, plan):
        placed = dict(leaf)
        if placed.get("loc") != IDENTITY_LOC:
            # MEASURED: a piece of a fuse over two solids read out of STEP comes
            # back with an identity location, so the tessellator has nothing to
            # factor out and the mesh is in the part's own coordinates -- which
            # is exactly the frame the loc below moves. A piece that arrived
            # with a location of its own would have that location dropped here
            # instead, and be drawn in the right place with the wrong shape.
            raise ValueError(
                f"view {view_id!r}: the tessellator gave the difference piece "
                f"{entry['name']!r} a location of its own ({placed.get('loc')!r}). "
                "The pieces are drawn in the part's coordinates and placed with "
                "the part's loc, so there is nowhere for a second one to go.")
        placed["name"] = entry["name"]
        # THE ONE FACT THIS WHOLE MODULE TURNS ON. The piece was measured off a
        # STEP file exported in the part's own coordinates; the part's place in
        # this view is the loc of the leaf that references it. Drop this line
        # and every bright piece is drawn at the origin.
        placed["loc"] = entry["loc"]
        # Set here rather than trusted from the tessellation, though both say
        # the same thing: these two are the whole point of the scene, and they
        # are what a reader checks it by.
        placed["color"] = entry["color"]
        placed["alpha"] = DIFFERENCE_ALPHA
        # Stated rather than parsed back out of the name, the way
        # `views.export_views` stamps a key on every leaf: which part a piece
        # belongs to is known here, and the browser should not have to
        # reconstruct it from a string.
        placed["key"] = entry["key"]
        drawn[entry["group"]].append(placed)
    return drawn, version


def _tessellate(plan):
    """The difference geometry turned into triangles, in ONE call. `(parts, version)`.

    THE FIRST ARGUMENT IS `None` AND IT IS LOAD-BEARING: with any other value
    the exporter writes `var shapes = {...}` instead of bare JSON (SPEC 5.1).
    With no `filename` it hands that JSON back as a string rather than writing a
    file, which is what this path wants -- a comparison is an answer to a
    request and never an artefact on the volume.

    FLAT, one object per piece, for the reason `views.export_views` exports
    flat: handed a dict the tessellator repeats a group's name a level deep,
    loses the leaf names and colours the group instead of the parts. The names
    below are positional and the caller overwrites them; what the tessellator is
    trusted for here is the geometry.

    IT TAKES A BARE `TopoDS_Shape` AND BRINGS NO CADQUERY WITH IT -- verified in
    this project's venv: after importing it and exporting a shape,
    `sys.modules` holds no `cadquery`. That is the whole reason this path
    exists: 271 MB resident for OCP against the ~450 MB `import cadquery` costs,
    in a process the hub starts to answer one request.
    """
    from ocp_tessellate.convert import export_three_cad_viewer_js

    document = json.loads(export_three_cad_viewer_js(
        None, *[entry["shape"] for entry in plan],
        names=[f"piece {index}" for index in range(len(plan))],
        colors=[entry["color"] for entry in plan],
        alphas=[DIFFERENCE_ALPHA] * len(plan)))
    return document.get("parts"), document.get("version")


def _group(name, root_id, version, leaves):
    """One child of the scene root, with its leaves' ids rebuilt under it.

    A group moves nothing -- every leaf under it already carries the loc of the
    part it is drawn on -- and the identity is written out because the viewer
    reads `loc` off every node it renders.
    """
    group_id = f"{root_id}/{name}"
    for leaf in leaves:
        leaf["id"] = f"{group_id}/{leaf['name']}"
    return {"version": version, "name": name, "id": group_id,
            "loc": IDENTITY_LOC, "parts": leaves}


def _one_version(seen, view_id):
    """The payload version the scene declares, which all its sources must agree on.

    A document says once, at the root, how the buffers under it are encoded, and
    a merged scene can only say it once. Two revisions built by different images
    -- or a difference tessellated by a newer library than the revisions were --
    would be one number over meshes written to two formats, which is a scene
    that renders wrong rather than one that fails to load.
    """
    distinct = set(seen.values())
    if len(distinct) != 1:
        described = ", ".join(f"{label}: {version!r}"
                              for label, version in sorted(seen.items()))
        raise ValueError(
            f"view {view_id!r}: the parts of this comparison do not agree on "
            f"the payload version ({described}). One scene declares one "
            "version, and the meshes under it have to be written to it.")
    return distinct.pop()


def _union_bb(document_a, document_b, view_id):
    """The box around both revisions, which is the box the viewer frames on.

    DEMANDED FROM BOTH DOCUMENTS, because the vendored viewer reads it exactly
    once and only off the root: `if (shapes.bb) { this._bbox = new
    BoundingBox(...) }`. A scene without one leaves `viewer.bbox` null, and
    everything that reads it -- the camera, the view cube, the section planes --
    works from nothing.

    THE DIFFERENCE CANNOT WIDEN IT: what was removed is part of A and what was
    added is part of B, so the union of the two boxes already contains every
    bright piece in the scene.
    """
    boxes = [_bb_of(document_a, REVISION_A_NAME, view_id),
             _bb_of(document_b, REVISION_B_NAME, view_id)]
    return {field: (min if field.endswith("min") else max)(
        box[field] for box in boxes) for field in BB_FIELDS}


def _bb_of(document, label, view_id):
    box = document.get("bb")
    if not isinstance(box, dict) or not all(
            isinstance(box.get(field), (int, float)) for field in BB_FIELDS):
        raise ValueError(
            f"view {view_id!r}: {label} carries no usable bounding box "
            f"({box!r}). The viewer takes the scene's own extent from the root "
            f"of the document and nowhere else, so the six numbers "
            f"{', '.join(BB_FIELDS)} have to be there.")
    return box
