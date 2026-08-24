#!/usr/bin/env python3
"""The retired parallel-list view form, and the message that refuses it.

`objects`/`names`/`colors`/`alphas` was a positional contract with nothing
holding the columns together, and it cost three real projects. A view carrying
any of those keys is refused, and the message prints the same view rewritten
into the `parts` form. No compatibility shim: the two forms would have to be
told apart on every read, and the half-converted view is exactly the state that
produces the bug.
"""

import json
import keyword
import re

from .matching import auto_colors
from .palette import DEFAULT_ALPHA


# The four keys of the parallel-list form this replaced:
#
#     "objects": [body, lid], "names": ["body", "lid"],
#     "colors": [...], "alphas": [1.0, 0.6],
#
# A positional contract with nothing holding the columns together. It cost
# three real projects: one had the colours a column short, so every part after
# the gap was painted as its neighbour; another carried `alpha: 0.9` on all
# twenty-two parts, which looks opaque and is not -- see NEARLY_OPAQUE_MIN. A view
# carrying any of these keys is refused, and the message prints the same view
# rewritten (legacy_views_error). No compatibility shim: the two forms would
# have to be told apart on every read, and the half-converted view -- `parts`
# next to a leftover `colors` -- is exactly the state that produces the bug.
LEGACY_VIEW_KEYS = ("objects", "names", "colors", "alphas")


def _identifier(text):
    """`"body (print)"` -> `body_print`: a name turned into something pastable.

    Pastable is the entire point, so what comes out has to be a name python
    accepts where the snippet puts it. Two things it does not: a leading digit,
    and a keyword -- a part honestly called "class" produced `{"shape": class,`
    and the rewritten view the error message offers no longer parsed at all.

    `str.isidentifier()` has the last word because `\\w` is wider than python's
    rule for names: "x²" survives the substitution and is not a valid
    identifier, and neither is anything else built out of the numeric
    characters that `\\w` lets through. Whatever is left over falls back to a
    plain `part`, which is a name the reader replaces anyway -- the message
    says so.
    """
    ident = re.sub(r"\W+", "_", str(text).strip(), flags=re.UNICODE).strip("_")
    if ident and (ident[0].isdigit() or keyword.iskeyword(ident)):
        # keyword.iskeyword covers None/True/False as well: they are keywords
        # in python 3, not names that happen to be taken.
        ident = f"part_{ident}"
    if not ident.isidentifier() or keyword.iskeyword(ident):
        return "part"
    return ident


def _as_column(value):
    """One of the four legacy lists, or an empty one if that is not what it is.

    A legacy view is refused, so nothing here is trusted to be well formed --
    and it is the ill-formed ones that most need the rewritten view printed
    back. `list()` on whatever the key happened to hold failed in both
    directions: `"objects": body` without the brackets, or a bare number, threw
    TypeError out of an error message and left the author looking at a
    traceback with this file's name on it; `"names": "body"` quietly became the
    four parts 'b', 'o', 'd', 'y' and produced a syntactically valid snippet
    made of nonsense.

    So a column is a list or a tuple, and anything else contributes nothing.
    The other columns still print, which is the point: the message is about
    retiring the form, and it must arrive whatever state the view is in.
    """
    return list(value) if isinstance(value, (list, tuple)) else []


def legacy_views_error(views, printables):
    """The old parallel-list views, refused -- and rewritten in the message.

    Everything the new form needs is already in the old one, so there is no
    reason to make anybody work the conversion out by hand: this prints the
    same views as per-part entries, ready to paste over what is there.

    The one thing it cannot know is which VARIABLE each object came from.
    `objects` is a list of values by the time this runs, and the name of the
    expression that produced each one is not carried anywhere -- so `shape` is
    filled with the part's own name from `names`, turned into an identifier,
    and the message says as much.

    Two things are dropped on the way through, because printing them back
    would be teaching the habit this change exists to break: `alpha: 1.0`, which
    is the default, and a colour the palette would have assigned anyway.
    """
    blocks = []
    for view in views:
        objects = _as_column(view.get("objects"))
        names = _as_column(view.get("names"))
        colors = _as_column(view.get("colors"))
        alphas = _as_column(view.get("alphas"))
        vid = str(view.get("id") or "").strip() or "view"

        # The lists may well be different lengths -- that is one of the faults
        # being retired -- so the longest one decides, and nothing is indexed
        # without a guard.
        count = max(len(objects), len(names), len(colors), len(alphas))
        labels = [str(names[i]).strip() if i < len(names)
                  and str(names[i]).strip() else f"part{i + 1}"
                  for i in range(count)]
        try:
            painted = auto_colors(objects, printables, {})
        except Exception:
            # This is an error message. It does not get to fail.
            painted = []

        shapes = [f"{_identifier(label)}," for label in labels]
        width = max((len(s) for s in shapes), default=0)

        lines = []
        # A key that is present but is not a list contributed no column at all
        # (_as_column), and silently rewriting `"objects": body` into a view
        # with one part fewer -- or with none -- would be the message hiding
        # the very thing that is wrong. It is a python comment so the snippet
        # still pastes.
        broken = [key for key in LEGACY_VIEW_KEYS
                  if key in view and not isinstance(view[key], (list, tuple))]
        if broken:
            listed = ", ".join(f'"{key}"' for key in broken)
            lines.append(
                f"        # {listed}: not a list here, so nothing could be "
                "read out of it"
            )
        for index in range(count):
            # json.dumps, not repr: the snippet is meant to be pasted into a
            # python file that quotes with " everywhere, and repr picks '.
            entry = (f'{{"shape": {shapes[index]:<{width}} '
                     f'"name": {json.dumps(labels[index], ensure_ascii=False)}')
            color = str(colors[index]).strip() if index < len(colors) else ""
            auto = painted[index] if index < len(painted) else ""
            if color and color.lower() != auto.lower():
                entry += f', "color": {json.dumps(color)}'
            if index < len(alphas):
                try:
                    alpha = float(alphas[index])
                except (TypeError, ValueError):
                    alpha = DEFAULT_ALPHA
                if alpha != DEFAULT_ALPHA:
                    entry += f', "alpha": {alpha:g}'
            lines.append(f"        {entry}}},")

        head = f'{{"id": {json.dumps(vid, ensure_ascii=False)}'
        if view.get("name"):
            head += f', "name": {json.dumps(str(view["name"]), ensure_ascii=False)}'
        tail = "    ]}"
        if view.get("nested_ok"):
            # Carried through untouched: it is an exemption somebody worked out
            # once, and a rewrite that drops it hands back a view that fails
            # the next check instead of the one it just fixed. Whatever is in
            # there is copied out as literally as it can be -- this runs before
            # nested_pairs has had a look at it, so it may be anything at all,
            # and an error message does not get to raise one of its own.
            try:
                pairs = ", ".join(
                    f"({', '.join(json.dumps(str(x)) for x in pair)})"
                    for pair in view["nested_ok"])
            except TypeError:
                pairs = repr(view["nested_ok"])
            tail = f'    ], "nested_ok": [{pairs}]}}'
        blocks.append("\n".join([f"    {head}, \"parts\": [", *lines, tail]))

    listed = ", ".join(repr(str(view.get("id") or "")) for view in views)
    opening = (
        f"views {listed} use the old parallel-list shape\n"
        "(objects/names/colors/alphas). Replace them with per-part entries:"
        if len(views) > 1 else
        f"view {listed} uses the old parallel-list shape\n"
        "(objects/names/colors/alphas). Replace it with per-part entries:"
    )
    return (
        opening + "\n\n"
        + "\n\n".join(blocks) + "\n\n"
        "`shape` above holds each part's own name, not the variable the object\n"
        "came from -- that name is nowhere to be found by the time views() has\n"
        "returned its values, so put your own back.\n"
        "Alpha 1.0 is the default and is omitted; keep it only where you\n"
        "actually want to see through the part. So is a colour the palette\n"
        "would assign anyway: a part that is in printables() is coloured\n"
        "automatically, and everything else in a view is drawn grey."
    )
