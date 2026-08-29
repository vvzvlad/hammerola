#!/usr/bin/env python3
"""views() -> what the viewer loads: validation, colouring, tessellation."""

import json
import re
import time
import unicodedata

from . import checklib
from .errors import BuildError
from .geometry import as_shapes
from .hubspec import MEMBER_RE, RESERVED_NAMES
from .legacy import LEGACY_VIEW_KEYS, legacy_views_error
from .matching import auto_colors
from .palette import DEFAULT_ALPHA, INVISIBLE_ALPHA, NEARLY_OPAQUE_MIN


# The two view ids the gate knows the meaning of. Everything else is just a
# tab: `print` is a bed and its parts may not overlap, `assembled` is the whole
# product and every printable has to be in it.
PRINT_VIEW_ID = "print"
ASSEMBLED_VIEW_ID = "assembled"
# Every key a view dict is read for. Anything else is reported as unknown --
# `nestedok` for `nested_ok` used to be accepted in silence, and a silent
# exemption is one that is not there.
VIEW_KEYS = frozenset({"id", "name", "parts", "nested_ok"})
# ...and every key one entry of `parts` is read for. `shape` and `name` are
# required; `color`, `alpha` and `note` are not.
PART_KEYS = frozenset({"shape", "name", "color", "alpha", "note"})

# The AUTHOR's note on a part: free text written here, in the model, that
# travels with the build and is shown to whoever opens it -- a catalogue name,
# a datasheet link, the fit that was taken. Not to be confused with the reader's
# own note (that one lives in their browser and never leaves it) or with a
# comment (written by a viewer, addressed to the agent, SPEC 7A).
#
# THE CEILING IS THE HUB'S, deliberately, and never above it: the hub checks
# every note again on the way in (`render.MAX_TEXT`), so a note this build
# accepts and the hub then refuses would be a whole build spent on a 422.
# tests/cadbuild/test_views.py holds the two numbers against the hub's.
MAX_NOTE_CHARS = 200
# ...and the same argument for HOW MANY parts may carry one: the hub caps the
# count too (`render.MAX_NOTES`), because a per-note ceiling leaves the total
# unbounded.
MAX_NOTES = 200

# ...and for the PART NAME, which is not only the label in the viewer's tree:
# it is the KEY a note is stored under in meta.json and the name written into
# every view file, and the hub checks it in both places with
# `render._check_part_name` -- the free-text ceiling plus the two character
# rules below.
MAX_NAME_CHARS = 200


def hub_text_problem(value, limit):
    """Why the hub would refuse this text on the way in, or None if it would not.

    A TRANSCRIPTION of `render._plain_text` and of the angle-bracket rule
    beside it, deliberately not an import: nothing in this package may reach
    into the serving half, because this code runs INSIDE the build process
    (src/buildproc/child.py) and importing a server module there would put
    server code in it. The duplication is the same trade the two ceilings above
    make, and it is held together the same way -- tests/test_notes.py runs one
    set of inputs through both sides and asserts they answer alike, so the next
    rule added on the hub fails there instead of drifting apart in silence.

    The three rules, and why each is the hub's:

      * the ceiling, so one build cannot push every other card off a page;
      * nothing Unicode files under category C -- Cc control, Cf format, Cs
        surrogate, Co private use, Cn unassigned. Cf is the one worth naming:
        U+202E RIGHT-TO-LEFT OVERRIDE is printable as far as a naive check
        goes, and it reverses the text AROUND whatever field carries it;
      * no angle bracket, because a build page is permanent, immutable for a
        year and shares an origin with every other project on the host --
        text that cannot open an element cannot become markup whatever ends
        up rendering it.

    A reason string rather than an exception: the caller knows the view and the
    part, and every message in this file names both.
    """
    if len(value) > limit:
        return f"is {len(value)} characters, over the {limit} the hub accepts"
    for char in value:
        if unicodedata.category(char).startswith("C"):
            return f"carries a non-printable character {char!r}"
    if "<" in value or ">" in value:
        return "carries an angle bracket"
    return None


def prepare_views(views, printables):
    """Validate the shape of everything views() returned, before any work.

    Split out from the tessellation so the whole contract -- ids, the per-part
    entries, the print layout, the printables coverage -- is settled while it
    still costs milliseconds. Tessellation is the slow half of a build, and
    finding a bad id after it is time spent on an answer already known.

    A view is a list of parts, one dict per part:

        {"id": "assembled", "name": "assembled", "parts": [
            {"shape": body, "name": "body"},
            {"shape": lid,  "name": "lid", "alpha": 0.6},
        ]}

    `shape` and `name` are required, `color` and `alpha` are not: a part with
    no colour is painted by the palette (see auto_colors) and a part with no
    alpha is opaque. `printables` is here for the colouring -- what is printed
    is what gets a colour -- and for the message that rewrites a legacy view.

    What comes out is the same view flattened into the parallel lists the
    tessellator takes, every one of them full length. That form is fine as an
    internal one: it is built here, in one place, from entries that cannot come
    out ragged. It was never fine as the contract with the author.
    """
    if not isinstance(views, (list, tuple)) or not views:
        raise BuildError("views() must return a non-empty list")

    # The old parallel-list form, checked for every view before anything else
    # is looked at. All of them at once, deliberately: converting a file is one
    # job, and one view per build would be a build per view.
    legacy = [view for view in views if isinstance(view, dict)
              and any(key in view for key in LEGACY_VIEW_KEYS)]
    if legacy:
        raise BuildError(legacy_views_error(legacy, printables))

    cache = {}
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

        objects, names, colors, alphas, part_notes = read_parts(view, vid)
        # Every part with no colour of its own gets one here, from what it is:
        # a printable, or scenery. An explicit "color" always wins.
        painted = auto_colors(objects, printables, cache, alphas)
        colors = [own or auto for own, auto in zip(colors, painted)]

        # All three transparency warnings, and warnings is all they are. A part
        # is printed exactly the same whether or not the picture of it draws
        # cleanly, so nothing here may stop a build.
        for name, alpha in zip(names, alphas):
            if alpha <= INVISIBLE_ALPHA:
                # Not the same defect as the band below: this part is not drawn
                # at all. It passes every rule about numbers, so the only thing
                # standing between "invisible on purpose" and "invisible by a
                # stray zero" is this line -- plus the coverage gate, which
                # from here on does not accept an invisible part as proof that
                # a printable is shown.
                print(
                    f"warning: view {vid!r} part {name!r} has alpha 0, so it is "
                    "not drawn at all: the picture is the same as if the part "
                    "were not in the view. It is not counted as showing "
                    "anything either -- a printable whose only appearance is "
                    "this one is reported missing. Take the part out of the "
                    "view if it does not belong there, or give it an alpha "
                    "that can be seen."
                )
            elif NEARLY_OPAQUE_MIN <= alpha < 1.0:
                print(
                    f"warning: view {vid!r} part {name!r} has alpha {alpha:g}, "
                    "which is the worst value available: nobody can tell it "
                    "from opaque, and the viewer still draws the part blended "
                    "with depth writing off. Transparent objects are then "
                    "sorted by the distance to their centres, and two big flat "
                    "parts whose centres nearly coincide swap places as the "
                    "model is turned -- a wall that appears and disappears "
                    "with the angle. Make it 1.0, or make it genuinely "
                    "see-through (0.6 or so)."
                )
        # Every view, not just `assembled`. The renderer is the same one for
        # all of them, so a scene with nothing solid in it draws just as badly
        # in `print` or in an exploded view; there was never a reason for this
        # one to be checked in a single tab.
        if not any(a >= 1.0 for a in alphas):
            print(
                f"warning: view {vid!r} has no fully opaque part -- all "
                f"{len(alphas)} of them are transparent. A scene made only of "
                "transparent objects has nothing solid to sort against and "
                "does not draw predictably; whatever is the outside of what "
                "this view shows belongs at alpha 1.0, and only the parts you "
                "mean to look through below it."
            )

        filename = f"{vid}.json"
        if filename in RESERVED_NAMES:
            raise BuildError(f"view {vid!r} would overwrite {filename}, which the hub owns")

        # nested_ok is validated HERE, for every view that carries one, and not
        # inside the print-layout check where it is used. Validating it at the
        # point of use meant it was only ever looked at on a `print` view with
        # two or more objects: rubbish in any other view went through in
        # silence, and so did the whole exemption when the key was misspelt.
        labels = list(names)
        nested_ok = nested_pairs(view.get("nested_ok") or (), labels, vid)
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
            "label": str(view.get("name") or vid),
            "objects": objects,
            "names": names,
            "colors": colors,
            "alphas": alphas,
            "file": filename,
            "nested_ok": nested_ok,
            # Only the parts that said something. A note is keyed by the part
            # NAME from here on, because that is what survives a rebuild and
            # what the browser has to match a part by.
            "notes": {name: note for name, note in zip(names, part_notes)
                      if note is not None},
        })

    # Called for its REFUSAL and the map thrown away: "the same part does not
    # carry two different notes" is a rule about the set of views, so it cannot
    # be checked inside the loop above, and this is the last moment before
    # anything is exported. build() calls the same function again for the map
    # itself -- one owner of the rule rather than two merges that can disagree.
    collect_notes(prepared)
    return prepared


def collect_notes(prepared):
    """Every author note in the model, merged into one part name -> text map.

    The same part appears in several views -- that is how one part is followed
    from `assembled` to `print` -- and the note belongs to the PART, so one name
    carrying the SAME text twice is one note and not a conflict.

    Two DIFFERENT texts under one name is refused, naming both views. The
    transport to the browser is keyed by name (meta.json), so there is exactly
    one slot for them: silent last-wins would put one view's sentence next to
    the part the other one was written about, and nothing would say so.
    """
    notes = {}
    origin = {}
    for view in prepared:
        vid = view["id"]
        for name, note in view["notes"].items():
            if name in notes and notes[name] != note:
                raise BuildError(
                    f"part {name!r} carries two different notes: view "
                    f"{origin[name]!r} says {notes[name]!r} and view {vid!r} "
                    f"says {note!r}. A note belongs to the part rather than to "
                    "the view, and the build stores one per name -- write the "
                    "same text in both, or leave the key out of the view it "
                    "was not meant for."
                )
            notes[name] = note
            origin[name] = vid
    if len(notes) > MAX_NOTES:
        raise BuildError(
            f"{len(notes)} parts carry a note, over the {MAX_NOTES} the hub "
            "accepts from one build. Notes are for the parts somebody has to "
            "be told something about, not for every part in the tree."
        )
    return notes


def read_parts(view, vid):
    """One view's `parts` as five full-length lists: shapes, names, colours,
    alphas, notes.

    Colours come back with None where the part named none -- the palette fills
    those in afterwards, and it needs to know which ones were left open. Notes
    do the same, for a different reason: most parts have nothing to say, and
    only the ones that do are written into meta.json.

    Names have to be strings, and inside one view they have to be different --
    see the two errors below for why each of those is an error and not a
    shrug.
    """
    parts = view.get("parts")
    if not isinstance(parts, (list, tuple)) or not parts:
        raise BuildError(
            f"view {vid!r} has no parts. A view is a list of parts, one dict "
            'each: "parts": [{"shape": body, "name": "body"}, ...]'
        )

    objects, names, colors, alphas, notes = [], [], [], [], []
    seen_names = {}
    for index, part in enumerate(parts):
        where = f"view {vid!r} part #{index}"
        if not isinstance(part, dict):
            raise BuildError(
                f"{where} is {type(part).__name__}, not a dict. Every part is "
                'written {"shape": <CadQuery object>, "name": "<label>"}, with '
                'optional "color" and "alpha".'
            )

        shape = part.get("shape")
        if shape is None:
            raise BuildError(f'{where} has no "shape": nothing to draw')
        as_shapes(shape, where)

        # The name is not decoration: `nested_ok` pairs are matched by it, the
        # layout gate names parts by it, and it is the label in the viewer's
        # tree. So it is required, it is a string, and no two parts of one view
        # share one.
        if "name" not in part:
            raise BuildError(
                f'{where} has no "name". The name is how the layout gate names '
                "this part, how a nested_ok pair points at it, and what the "
                "viewer's tree shows."
            )
        name = part["name"]
        if not isinstance(name, str):
            # str() used to be applied to whatever was there, so ["body"]
            # became the part "['body']" and 42 became "42" -- a name nobody
            # wrote, matching no nested_ok entry, printed back in every message
            # about the part. A number under "name" is a mistake, not a label.
            raise BuildError(
                f'{where}: "name" is {name!r}, which is a '
                f"{type(name).__name__} and not a string. Write the label out: "
                '{"shape": ..., "name": "body"}.'
            )
        name = name.strip()
        if not name:
            raise BuildError(
                f'{where} has an empty "name". The name is how the layout gate '
                "names this part, how a nested_ok pair points at it, and what "
                "the viewer's tree shows."
            )
        problem = hub_text_problem(name, MAX_NAME_CHARS)
        if problem:
            raise BuildError(
                f'{where}: "name" {problem}: {name!r}. A name travels further '
                "than the viewer's tree -- it is the KEY a note is stored "
                "under and the name written into every view file -- and the "
                "hub checks it again in both places on the way in, answering "
                "422 on a build that already ran. Keep it to plain, printable "
                "text without angle brackets."
            )
        if name in seen_names:
            # A duplicate is not a cosmetic problem. nested_ok pairs are
            # frozensets of names, so two parts called the same thing collapse
            # to a one-element set that exempts every overlap between any two
            # of them; the layout gate then reports "'leg' and 'leg' overlap",
            # naming neither; and the viewer's tree shows two branches nobody
            # can tell apart. Between views a repeat is normal and expected --
            # that is how the same part is followed from `assembled` to
            # `print`. Inside one view it is two parts with one identity.
            raise BuildError(
                f"view {vid!r} has two parts named {name!r} "
                f"(#{seen_names[name]} and #{index}). Inside one view a name "
                "is an identity: nested_ok pairs point at it, the layout gate "
                "reports overlaps by it, and the viewer's tree is labelled "
                "with it -- two parts sharing one name make all three "
                "meaningless. Give them names that tell them apart "
                '("leg front left", "leg front right"). The SAME name in '
                "another view is right and expected: that is how one part is "
                "followed from view to view."
            )
        seen_names[name] = index
        where = f"view {vid!r} part {name!r}"

        color = part.get("color")
        if color is not None:
            color = str(color).strip()
            if not color:
                raise BuildError(
                    f'{where}: "color" is empty. Leave the key out and the '
                    "palette picks one."
                )
            # Checked with the tessellator's own parser, and imported here
            # rather than at the top of the file: most parts name no colour at
            # all, so most builds never pay for the import. A bad colour is
            # otherwise found by export_views, after every part has been
            # exported and meshed -- minutes spent on an answer visible now.
            from ocp_tessellate.utils import Color
            try:
                Color(color)
            except Exception as exc:
                raise BuildError(f"{where}: color {color!r} is not one ({exc})") from exc

        alpha = part.get("alpha", DEFAULT_ALPHA)
        if isinstance(alpha, bool) or not isinstance(alpha, (int, float)):
            raise BuildError(
                f"{where}: alpha is {alpha!r}, which is not a number. "
                f"Transparency runs 0..1 and defaults to {DEFAULT_ALPHA}."
            )
        alpha = float(alpha)
        if not 0.0 <= alpha <= 1.0:
            raise BuildError(
                f"{where}: alpha is {alpha:g}, outside 0..1. 0 is invisible "
                "and 1 is opaque; there is nothing on either side of that, and "
                "the viewer clamps silently rather than telling you."
            )

        note = part.get("note")
        if note is not None:
            if not isinstance(note, str):
                # Not stringified, for the reason "name" is not: str() would
                # turn a number or a list into a sentence nobody wrote and then
                # show it to every reader of the model.
                raise BuildError(
                    f'{where}: "note" is {note!r}, which is a '
                    f"{type(note).__name__} and not a string. A note is the "
                    "text shown to whoever looks at this part: "
                    '{"shape": ..., "name": "screw", "note": "M3x8 DIN912"}.'
                )
            note = note.strip()
            if not note:
                # An empty note is a sentence somebody meant to write, not a
                # part with nothing to say -- that one leaves the key out.
                raise BuildError(
                    f'{where}: "note" is empty. Leave the key out for a part '
                    "there is nothing to say about; an empty string is a note "
                    "that was started and not written."
                )
            if len(note) > MAX_NOTE_CHARS:
                raise BuildError(
                    f'{where}: "note" is {len(note)} characters, over the '
                    f"{MAX_NOTE_CHARS} the hub accepts. A note is one line "
                    "about the part -- a catalogue name, a link, the fit that "
                    "was taken -- and not the documentation of it."
                )
            # The ceiling is answered above, with a message of its own, so what
            # is left for the shared rule here is the CHARACTERS -- one
            # transcription of the hub's, used for the name as well.
            problem = hub_text_problem(note, MAX_NOTE_CHARS)
            if problem:
                raise BuildError(
                    f'{where}: "note" {problem}: {note!r}. The hub checks every '
                    "note again on the way in and answers 422, so this is a "
                    "whole build's worth of geometry spent on a sentence. "
                    "`clearance < 0.2 mm` is the one that catches everybody: "
                    "an angle bracket is text that could open an element on a "
                    "page shared with every other project on the host, so "
                    "write it as `0.2 mm clearance` instead."
                )

        unknown = sorted(set(part) - PART_KEYS)
        if unknown:
            # A warning for the same reason the view-level one is (below): this
            # file is shared by every project in the organisation. But a
            # misspelt "alfa" leaves the part opaque and says nothing, so it is
            # said out loud.
            print(
                f"warning: {where} has key(s) "
                f"{', '.join(repr(k) for k in unknown)}, which the build does "
                f"not read. Known keys: {', '.join(sorted(PART_KEYS))}."
            )

        objects.append(shape)
        names.append(name)
        colors.append(color)
        alphas.append(alpha)
        notes.append(note)
    return objects, names, colors, alphas, notes


def nested_pairs(declared, labels, vid):
    """The pairs this view says are *meant* to be nested, validated.

    A part legitimately laid inside the bore of a ring is not a mistake, and
    a check that cannot be told so is a permanent red the author can only get
    rid of by deleting the check. So a view may say:

        "nested_ok": [("shim", "ring")]

    A list of PAIRS. A flat `("shim", "ring")` is two names, matches nothing
    and would silently leave the exemption off -- so it is refused, and so is
    a name that is not one of this view's parts, which is the same mistake
    made with a typo.

    The shape of the list is checked by checklib, which owns that rule for
    `allowed_touching` too. This file had its own copy and the copy had gone
    wrong in a way worth remembering: it listed the names with `[str(x) for x
    in pair]` and then asked `all(isinstance(x, str) for x in pair)` -- a
    second walk over the same iterable. For a generator the second walk is
    empty, `all()` of nothing is True, and a pair of numbers was accepted and
    quietly stringified. Only the "are these names in this view" half is left
    here, because only this file knows the answer.
    """
    try:
        allowed = checklib.name_pairs(declared, "nested_ok", f"view {vid!r}: ")
    except ValueError as exc:
        raise BuildError(str(exc)) from exc

    for pair in allowed:
        unknown = sorted(x for x in pair if x not in labels)
        if unknown:
            raise BuildError(
                f"view {vid!r}: nested_ok names "
                f"{', '.join(repr(x) for x in unknown)}, which is not one of "
                f"this view's parts ({', '.join(repr(x) for x in labels)}). "
                "An exemption for a part that is not in the view exempts "
                "nothing; the overlap it was written for is still unreported."
            )
    return allowed


def visible_names(view):
    """The names of the parts this view actually draws.

    A part at alpha 0 is invisible, and an invisible part's name is not
    evidence that anything is shown -- the coverage gate would otherwise
    certify a printable as visible on the strength of a label attached to
    nothing. Kept next to names_mention, which is the only thing that reads it.
    """
    return [name for name, alpha in zip(view["names"], view["alphas"])
            if alpha > INVISIBLE_ALPHA]


def names_mention(names, key):
    """Is `key` one of the parts these view part names are talking about?

    A print view calls the part "body (print)" and the assembled one calls it
    "body"; both are the printable `body`. Match on whole words so that a
    part named "lid" is not found in "solid".
    """
    wanted = re.findall(r"[a-z0-9]+", key.lower())
    if not wanted:
        return False
    for name in names:
        words = re.findall(r"[a-z0-9]+", str(name).lower())
        span = len(wanted)
        if any(words[at:at + span] == wanted for at in range(len(words) - span + 1)):
            return True
    return False


def export_views(prepared, out_dir):
    """Tessellate every prepared view into its own bare-JSON file."""
    from ocp_tessellate.convert import export_three_cad_viewer_js

    entries = []
    for view in prepared:
        vid = view["id"]
        objects, names = view["objects"], view["names"]
        colors, alphas = view["colors"], view["alphas"]
        filename = view["file"]
        target = out_dir / filename

        # var=None is what makes this a bare JSON document. With any other
        # value the file becomes `var shapes = {...}`, which the page cannot
        # fetch() -- and the failure is silent, an empty scene (SPEC 5.1).
        started = time.monotonic()
        # All four lists are full length and in step -- prepare_views built
        # them that way out of the per-part entries, which is the whole reason
        # those entries exist.
        export_three_cad_viewer_js(
            None, *objects, names=names, colors=colors, alphas=alphas,
            filename=str(target),
        )
        if not target.exists():
            raise BuildError(f"tessellation produced no {filename}")
        try:
            json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise BuildError(
                f"{filename} is not bare JSON ({exc}); the first argument to "
                "export_three_cad_viewer_js must be None"
            ) from exc

        size = target.stat().st_size
        print(f"  {vid}: {len(objects)} parts, {size / 1e6:.2f} MB, "
              f"{time.monotonic() - started:.1f}s")
        entries.append({
            "id": vid,
            "name": view["label"],
            "file": filename,
            "parts": len(objects),
        })
    return entries
