#!/usr/bin/env python3
"""Limits and names fixed by cad_snapshot_hub docs/SPEC.md sections 7 and 7.1.

Mirrored here so a bad model fails locally with a readable message instead of
coming back as an opaque 422 from the hub. Do not improvise: the hub validates
every field.
"""

import re
import unicodedata


# Hub-side limits, mirrored so a bad model fails here with a readable message
# instead of coming back as an opaque 422 from the hub (SPEC 7.1).
MEMBER_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
LABEL_RE = re.compile(r"\A[A-Za-z0-9._-]{1,32}\Z")
RESERVED_NAMES = {"meta.json", "index.html", "metrics.json"}
MAX_BUILD_BYTES = 64 * 1024 * 1024

# The AUTHOR's note on a part: free text written in the catalogue that travels
# with the build and is shown to whoever opens it -- a catalogue name, a
# datasheet link, the fit that was taken. Not to be confused with the reader's
# own note (that one lives in their browser and never leaves it) or with a
# comment (written by a viewer, addressed to the agent, SPEC 7A).
#
# THE CEILING IS THE HUB'S, deliberately, and never above it: the hub checks
# every note again on the way in (`render.MAX_TEXT`), so a note this build
# accepts and the hub then refuses would be a whole build spent on a 422.
# tests/cadbuild/test_views.py holds the numbers here against the hub's.
MAX_NOTE_CHARS = 200
# ...and the same argument for HOW BIG THE CATALOGUE MAY BE: the hub caps that
# too (`render.MAX_PARTS`), because a per-record ceiling leaves the total
# unbounded -- a hundred thousand legal records make a meta.json nobody can
# load, served under a year of `immutable`.
#
# IT WAS `MAX_NOTES` AND COUNTED THE PARTS CARRYING A NOTE. The note moved
# inside the record it is about, so there is no count of notes left to take --
# and the records without one are exactly what a note-shaped ceiling could not
# see: a catalogue of bought screws costs the same megabytes and carries no
# note at all. Renamed on both sides at once, because the two are compared by
# name in tests/cadbuild/test_naming.py and a ceiling whose name says notes and
# whose job is the catalogue is a number nobody can reason about.
MAX_PARTS = 200
# ...and for the VIEW's own name -- the caption in the picker, written into
# meta.json by export_views and checked there again by the hub
# (`render._plain_text(..., "view name")`). Same ceiling, same argument.
MAX_VIEW_NAME_CHARS = 200

# How deep a view file's part tree may nest, counted the hub's way: the root
# document is 0, a part directly under it is 1, and a part inside a group is one
# deeper. Mirrored from `render.MAX_VIEW_DEPTH` for the reason the ceilings
# above are -- a group nest this build accepts and the hub refuses is a whole
# build spent on a 422 -- and the hub's own reason for having one is that it
# walks the tree, so an unbounded nest turns a check meant to answer 422 into a
# 500.
MAX_VIEW_DEPTH = 64

# THERE IS NO PART-NAME CEILING HERE ANY MORE, and its absence is a decision
# rather than a gap. A part's name in a view file is a CATALOGUE KEY (or a
# group name, held to the same rule), and MEMBER_RE above is strictly narrower
# than the hub's `_check_part_name`: 128 characters against 200, and an
# alphabet of letters, digits, dot, dash and underscore against "anything
# printable without an angle bracket". Anything MEMBER_RE accepts the hub
# accepts, so a second ceiling here would be dead text that still reads like a
# working check. tests/cadbuild/test_views.py asserts that containment rather
# than trusting this paragraph.


def hub_text_problem(value, limit, *, angle_brackets_ok=False):
    """Why the hub would refuse this text on the way in, or None if it would not.

    A TRANSCRIPTION of `render._plain_text` and of the angle-bracket rule
    beside it, deliberately not an import: nothing in this package may reach
    into the serving half, because this code runs INSIDE the build process
    (src/buildproc/child.py) and importing a server module there would put
    server code in it. The duplication is the same trade the ceilings above
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

    THE THIRD RULE IS NOT ON EVERY FIELD THE HUB CHECKS, which is why it is a
    flag and not simply part of the transcription. The hub bans brackets in a
    note and in a part name (`render._check_part_name`) and does NOT ban them
    in a title, in a project name or in a view name -- those go through
    `_plain_text` alone. The asymmetry is the hub's and is argued there: our
    own pages write those three with `textContent`, where `<b>` is three
    characters on screen, while the vendored viewer assigns a part name to
    `innerHTML`, where the same three are a tag. Copying it faithfully is what
    keeps the two verdicts EQUAL; banning brackets on everything here would
    refuse a title the hub accepts, which is safe and still wrong -- a model
    turned away for a rule that does not exist. `False` is the default so that
    a caller which says nothing gets the rule rather than loses it.

    A reason string rather than an exception: the caller knows the view and the
    part, and every message built on this names both.
    """
    if not isinstance(value, str):
        # The hub's `_check_part_name` opens with this same isinstance, and
        # here it is what keeps the gate from CRASHING instead of answering:
        # `len()` happens to work on a list, and `unicodedata.category` of its
        # first element then raises a bare TypeError out of a build. Every
        # caller today checks the type before it gets here; this is the line
        # that keeps that true for the next one.
        return f"is {type(value).__name__}, not a string"
    if len(value) > limit:
        return f"is {len(value)} characters, over the {limit} the hub accepts"
    for char in value:
        if unicodedata.category(char).startswith("C"):
            return f"carries a non-printable character {char!r}"
    if not angle_brackets_ok and ("<" in value or ">" in value):
        return "carries an angle bracket"
    return None


# The slot name `hammerola build` publishes under. Reserved on the hub side,
# where it is a pointer that gets overwritten rather than a snapshot id
# (SPEC 7.6).
DEV_LABEL = "dev"

# The project id `cad-publish init --test` used to write. NOTHING WRITES IT ANY
# MORE -- the flag went with the local build path (issue #20) -- so what reaches
# `project.refuse_test_id()` is a project.json somebody wrote by hand or carried
# over from before. Everything about the string is still on purpose:
#
#   * it is not 12 hex characters, so nobody mistakes it for a generated id;
#   * it says what it is IN THE URL, which is the one place an id is ever seen;
#   * project.refuse_test_id() matches this exact string and stops any run that
#     would push under it, so the failure mode the flag could create -- a
#     throwaway checkout publishing over a real project, or littering the hub
#     with a project called "test" -- cannot happen quietly. It is a hard stop
#     with a message.
#
# It still has to pass MEMBER_RE above, because the point is to exercise the
# real pipeline and not a shortened one.
#
# It lives here, next to the other names the whole package agrees on, rather
# than in the command that once wrote it: project.py is what has to recognise
# it, and importing a one-shot init command from the build path to read one
# string would point the dependency backwards. Two spellings of it would mean a
# test id the build no longer recognises, and the entire safety of the flag is
# that refusal.
TEST_ID = "local-test-do-not-publish"
