"""On-disk layout, safe unpacking and atomic publication.

NOTHING HERE EVER DELETES A PUBLISHED BUILD. There is no retention window and no
age ceiling: a build that landed stays until somebody removes it by hand
(decision of 2026-08-27, SPEC 5.3 and 7.3). A revision is tens of megabytes and
disk is cheaper than a mechanism that has to be written, tested, explained and
that can delete the wrong thing — and what the absence buys is exact: every
build URL is served with a year of `immutable`, so a link that was pasted into
chat goes on resolving for as long as the volume does. The cost is that the
volume grows monotonically, and the day it runs out is manual work rather than
automatic.

Layout under DATA_DIR (SPEC 3, 7.2). Everything here is runtime state and lives on
the docker volume; templates and viewer assets deliberately live outside it,
because the volume would shadow them.

    <data>/index.json                      cards for the front page
    <data>/project/<pid>/builds.json       build picker for one project
    <data>/project/<pid>/latest            SYMLINK -> <commit>, newest build
    <data>/project/<pid>/dev/              THE local slot — one directory, rewritten
                                           on every laptop push (SPEC 7.6)
    <data>/project/<pid>/<commit>/         one immutable build
    <data>/project/<pid>/.tmp-<commit>-<uuid>/   staging, never served
    <data>/jobs/<id>/                      one build job (src/jobs.py)
    <data>/.src-<uuid>/                    one pushed SOURCE tree, being built
    <data>/.body-<uuid>                    the BODY that tree came out of, kept
                                           until its build says whether to store it
    <data>/sources/<digest>/source.tar.gz  that body, kept: the code of one revision
    <data>/sources/<digest>/log.txt        what the build of that revision printed

`sources/` IS THE CODE OF EVERY PUBLISHED REVISION, and three things about it are
decisions rather than arrangement (issue #17).

It is OUTSIDE the build directory. A build directory is served publicly and with
a year of `immutable`, so a mistake there cannot be taken back — the copies are
already handed out. This tree is served by nothing: the only way out of it is
`GET /api/v1/sources/<revision>`, behind EDIT_TOKEN, and the file server's
`_safe_name` never reaches this far anyway.

It is CONTENT-ADDRESSED, and that is not a second naming scheme to keep in step
with anything: `<digest>` is `_payload_digest` of the sources, which is exactly
what `mint_revision` names the revision after. The address of the code and the
name of the revision are one string. It follows that pushing the same tree twice
cannot produce a second archive — the second push resolves to the same name — and
that a revision published under a name the CALLER chose (the route that still
takes a `<commit>`) is stored under its digest instead, i.e. not at the name in
its own URL.

It is written ONLY AFTER A PUBLISH LANDS. The sources of a build that failed are
not kept: the author is looking at the failure the moment the command returns and
the tree is on their own disk, so the hub would be storing what nobody comes back
for — and a stored tree that belongs to no published revision is a revision this
store cannot answer for. Nothing prunes it afterwards; a revision's code lives
exactly as long as the revision (SPEC 5.3).

`latest` and `dev` are the two names a build directory may not claim, for
different reasons: `latest` is a symlink the store moves, and `dev` is the local
slot itself, a real directory the store rewrites.

Two naming rules carry security weight and are enforced by whitelist rather than
by blacklist, because a whitelist cannot be walked around by an encoding nobody
thought of:

  * `<pid>` and `<commit>` come from the URL and may only be `[A-Za-z0-9_-]`, so
    they can never contain a separator or a dot component. `latest` and `dev` are
    reserved.
  * a member name inside the uploaded tar is a RELATIVE PATH: `/`-separated
    components, each of the same shape as a bare filename plus dots. `../`,
    `/etc/passwd`, `a/../../b`, `a//b` and `a/./b` are all rejected on the name
    alone — before the member's TYPE is even considered — because no component
    may be empty, `.` or `..`, and none may start with a dot at all.
"""

import errno
import gzip
import hashlib
import json
import os
import re
import shutil
import tarfile
import threading
import time
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from src import render

# Identifiers that arrive in the URL. No dot at all: that keeps a build directory
# from ever colliding with `builds.json`, and keeps it from being a dot-entry the
# file server hides.
# `\A`/`\Z` and not `^`/`$`: in Python `$` also matches just before a trailing
# newline, so `^...$` accepts "proj1\n" — which would create a directory with a
# newline in its name and put a bare LF into the `Location` header of the reply.
SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

# The two moving names of a project. Neither may ever be cached, and that is the
# only thing they have in common — mechanically they are different objects.
#
#   latest -> a SYMLINK to the newest build made FOR A COMMIT. The link people
#             paste into chat, so it means one thing only: the project as of
#             some commit.
#   dev    -> THE local slot (SPEC 7.6): one directory, overwritten by every push
#             from the author's laptop. There is exactly one, like there is
#             exactly one `latest`, and it has no history because what it shows
#             is not a version of anything — it is the current state of a working
#             copy. Uncommitted work must never move `latest`, or the public link
#             starts meaning "whatever was on somebody's machine at the time".
LATEST_LINK = "latest"
DEV_LINK = "dev"
POINTER_NAMES = (LATEST_LINK, DEV_LINK)

# Names a build may not claim, because the hub already answers to them: `latest`
# is a pointer symlink, `dev` is the local slot's directory, and both are the
# last segment of a publish route.
# `resolve` is deliberately NOT here: it is reserved by the COMMENT api only
# (SPEC 7A.2), where it costs a build the ability to be commented on and nothing
# else, and app.py documents that trade.
RESERVED_BUILD_NAMES = set(POINTER_NAMES)

# ONE COMPONENT of a member's path inside the uploaded tar. The archive carries a
# TREE now — a model's source is `model.py`, `enclosure.py`, `scripts/`, `ref/` —
# so a member name is a relative path and this is the rule each of its
# `/`-separated pieces has to pass. The alphabet is exactly the one a whole member
# name had to match while the archive was flat, which is what makes the move to
# trees an addition rather than a relaxation: dots are allowed (file extensions)
# but a component must START alphanumeric, so `.hidden`, `.`, `..` and the empty
# string are all out, and the class contains no `/`, no backslash, no NUL and
# nothing outside ASCII — so a component can never itself be a separator, a
# traversal hop, or a lookalike of one in some other script.
# `\Z` for the same reason as above: `$` would let "model.stl\n" through.
#
# THE WIDTH IS A NAME AND NOT A LITERAL, and that is not tidiness: the same 128
# is what MAX_MEMBER_NAME_CHARS is built out of. Spelt twice, the two drift, and
# they drift in the direction that refuses honest pushes — widen the alphabet
# alone and a member this very module calls legal is turned away by a ceiling
# computed from the old width. One name, and the regex is built from it.
MAX_COMPONENT_CHARS = 128
SAFE_COMPONENT = re.compile(
    rf"\A[A-Za-z0-9][A-Za-z0-9._-]{{0,{MAX_COMPONENT_CHARS - 1}}}\Z")

# Ceiling on the DEPTH of a member's path, counted in components including the
# file name itself: `model.py` is 1, `scripts/gen/parts.py` is 3.
#
# Eight, for two reasons that both need a number rather than "deep enough". A
# model's source is shallow by nature (`ref/vendor/rev2/part.step` is 4 and
# already contrived), so eight leaves room without inviting anything. And it
# bounds the longest path this can produce: 8 components of 128 characters plus 7
# separators is 1031 bytes, which added to the deepest staging path the hub can
# build — data dir, `project/`, a 64-character pid, `.tmp-` + a 64-character
# commit + a 32-hex uuid — stays far below PATH_MAX (4096 on Linux). Without a
# ceiling here a legal archive could push a path past it and turn a publish into
# an ENAMETOOLONG deep inside extraction, i.e. a 500 on an archive that broke no
# rule. It also caps the directory walk at 8 `mkdir`+`openat` pairs per member.
MAX_PATH_DEPTH = 8

# Ceiling on the number of entries in one archive, directory entries included —
# every entry costs an iteration whether or not anything is extracted from it.
#
# 1024 rather than the 256 that fitted a flat build: what arrives is now a source
# TREE, where a `scripts/` and a `ref/` with a few dozen files each are ordinary,
# and 256 is close enough to a real project to be hit by an honest push. 1024 is
# still far below anything that costs us: the work per member is one `openat` and
# one write loop, and the only state kept per member is its path in the
# duplicate map — 1024 × ~1 KiB worst case, ~1 MiB, against four concurrent
# publish slots. The bytes are bounded separately and much lower (see
# `max_build_bytes`), so this number governs SYSCALLS and bookkeeping, not disk.
MAX_MEMBERS = 1024

# How many refused member names one 422 carries, and how much of each of them.
#
# A refusal names EVERY member whose path this hub cannot take, not just the
# first (issue #42) — a source tree whose `ref/` holds nineteen cyrillic
# file names is one rename job, and answering with one name at a time made it
# nineteen pushes. But THE NAMES ARE THE SENDER'S OWN TEXT, and the sender is
# not trusted: listing them is this hub repeating attacker-chosen bytes into a
# JSON body, into `logger.warning` (every refusal here is logged) and from there
# into whatever reads `docker logs`. So the answer cannot be "list all of them",
# and three separate ceilings apply, one per way that echo could be abused.
#
#   * HOW MANY. Ten is enough to say "this is not one file" and to cover most of
#     the tree that prompted this; it is not enough to make a 422 into a
#     broadcast channel. The side that names every single one is the CLIENT,
#     before anything is sent, on the author's own machine — where the strings
#     are the author's own and not untrusted at all (`hammerola/pack.py`).
#     THE CEILING IS ALSO WHERE COLLECTING STOPS, not only where printing does.
#     Be precise about what that buys, because the obvious claim is false: our
#     list holds REFERENCES, and `tarfile` retains a TarInfo — name included —
#     for every member it has read, so dropping ours frees nothing (measured:
#     32 names of 100 000 characters cost 3.66 MB whether this module keeps
#     them or not). What bounds that amplification is MAX_MEMBER_NAME_CHARS
#     below. Stopping here buys something smaller and still worth having: what
#     reaches `_refused_names_error` is at most ten strings of at most
#     MAX_REFUSED_NAME_CHARS, whatever the archive was, so the message builder
#     cannot be handed something unbounded by a future caller.
#   * HOW LONG, applied to WHAT IS PRINTED. A member name is NOT bounded by
#     SAFE_COMPONENT — that is the rule it just failed — and GNU/PAX long-name
#     headers carry names of arbitrary length, so without a cut one member could
#     make the hub print a megabyte. The cut takes out the MIDDLE rather than
#     the tail: what identifies a file is the front of its path and its own
#     name, and cutting the tail throws the second one away. It is applied to
#     the raw name AND again to the escaped one, because escaping EXPANDS: a
#     control character costs four characters, a lone surrogate or a Cf six, an
#     astral non-printable ten. Cutting only the raw name capped the wrong
#     string — ten legal names of 200 astral characters printed 7 892 of them
#     under a message claiming a ceiling of 80.
#   * WHEN. Both cuts happen where the name is RECORDED, not where the message
#     is built. Not for memory (see above) but for locality: the list is then
#     printable text by construction, so the ceiling holds no matter what any
#     later reader of it does, and there is one place to look for it.
#   * WHAT SHAPE. Every name goes through `repr()`, which escapes exactly what
#     `str.isprintable()` rejects — control characters, the lone surrogates
#     `tarfile` decodes an undecodable name into, U+202E and the rest of Cf —
#     while leaving ordinary letters alone, so a cyrillic name still reads as
#     one. Applied AFTER the raw cut, which is the order that keeps `repr()`
#     from ever building the expansion of a megabyte-long name in the first
#     place; the second cut then holds the ceiling on the result.
MAX_REFUSED_NAMES_REPORTED = 10
MAX_REFUSED_NAME_CHARS = 80

# Ceiling on ONE entry's name PLUS its link target, and the only bound there is
# on the memory `tarfile` spends on either.
#
# It exists because of what collecting names changed. While the walk raised at
# the first unusable name it read one name and stopped; now it reads every
# header in the archive, and `tarfile` retains a TarInfo — name included — for
# every entry it has seen. A name is not bounded by anything else here: a
# GNU/PAX long-name header is a pseudo-member whose data `tarfile` reads whole
# and NEVER yields, so its bytes reach neither `member.size` nor the unpacked
# total, and it compresses to nothing. Measured: 64 members with a megabyte of
# name each is a 70 KB body and 69.5 MB of process memory — a thousandfold
# amplification, in the process that also serves the whole site. Bounding each
# name bounds the total at MAX_MEMBERS times this — about a million CHARACTERS,
# which is the unit this ceiling is counted in and not the unit the paragraph
# cares about. Python stores a string with any non-ASCII in it at up to four
# bytes per character, so a million characters of cyrillic or CJK names is
# nearer twenty megabytes of memory than one. Bounded either way; just not
# bounded at the number a byte-shaped reading of "a megabyte" suggests.
#
# PER NAME RATHER THAN A RUNNING TOTAL, and the difference is not stylistic. A
# total has to be compared against the largest sum a legal archive could reach,
# and getting that arithmetic wrong refuses honest pushes: the first version of
# this left out the `./` that `tar czf x.tar.gz .` puts on every name — the same
# prefix stripped twenty lines below — and refused a legal 1024-member archive
# by 1024 characters. Per name there is no sum to get wrong.
#
# The number is the longest name a member of an acceptable archive can have:
# MAX_PATH_DEPTH components of 128 characters (SAFE_COMPONENT's own ceiling),
# the separators between them, and that `./`. A name longer than this cannot
# belong to an acceptable member — it fails the alphabet or the depth by
# construction — so refusing on length alone decides nothing that was not
# already decided.
#
# IT IS CHECKED ON DIRECTORY ENTRIES TOO, and that is a deliberate narrowing.
# Nothing else looks at a directory entry: it is skipped before the depth and
# the alphabet, so today an archive may carry one named 50 components deep and
# still publish. `tarfile` holds its name exactly like a file's, so leaving them
# unchecked would leave the hole open through them. What this rejects is an
# archive whose directory entry is deeper or wider than any member could be —
# which describes a directory no member of a legal archive could live in.
#
# AND IT COUNTS `linkname` IN THE SAME SUM, which is the half that is easy to
# miss. A link target arrives by the same mechanism (GNU `LONGLINK`, pax
# `linkpath`), hangs on the same retained TarInfo, reaches neither `member.size`
# nor the unpacked total, and compresses to nothing — the whole argument above,
# for a second field. It is NOT enough that links are refused: `tarfile` attaches
# a pending `LONGLINK` to whatever header comes next, REGULAR FILES INCLUDED, so
# an archive of ordinary files each preceded by a megabyte of link target passes
# the alphabet, passes the type check and PUBLISHES. Measured against `main`,
# which has this hole today: 200 such members are a 212 KB body and a 202 MB
# peak. A legal member's `linkname` is empty — links are refused whatever they
# point at — so summing the two fields costs nothing legal.
#
# THE FIELDS ARE FOUR, and the way to think about them is the retained TarInfo
# rather than the word "name". `tarfile` hangs sender-controlled data on that
# object in four places, and every one of them arrives while the header is
# parsed, escapes `member.size` and the unpacked total, and compresses to
# nothing:
#
#   1. `name`               — capped here;
#   2. `linkname`           — capped here, in the same sum;
#   3. the whole `pax_headers` dict, `uname` and `gname` included — capped by
#      MAX_PAX_HEADER_CHARS below. Those two are attributes as well, and are
#      deliberately not summed a second time: an oversized one can only have
#      arrived as a pax record, because ustar and GNU give the field 32 fixed
#      bytes. See `_pax_header_chars`.
#   4. `sparse`, the map of a sparse member — refused outright below. It is a
#      LIST OF TUPLES rather than text, which is why three rounds of looking for
#      name-shaped fields walked past it. Measured: an old-GNU sparse header
#      whose chain of extended blocks holds 21 entries apiece turns a 447 KB body
#      into 4.2 million tuples and 303.8 MB — while every ceiling above sees
#      `name + linkname` of 10 characters and an EMPTY pax dict.
#
# ENUMERATING THE FIELDS ONE AT A TIME DID NOT CONVERGE, and that is why there
# is a second mechanism. Three rounds, three new fields, each found after the
# list was declared complete: `linkname` after `name`, `pax_headers` after
# `linkname`, `sparse` after that. Each miss had its own excuse — "links are
# refused anyway", "those are not names", "that is not text" — and each excuse
# was about the ROUTE IN rather than about what the object ends up holding
# (`sparse` alone has four routes: the old-GNU chain, a map in the member's data,
# one pax record, and repeated pax records that the dict collapses into one —
# the last invisible to `_pax_header_chars` by construction).
#
# So the ceilings above are no longer the whole answer. `_CountingReader` bounds
# what is READ FROM THE STREAM, which is upstream of every field there is and of
# every field a later `tarfile` may grow, and it is what makes "which field did
# we forget" stop being the question. The field ceilings stay because they answer
# a different one — they are semantic, and refuse a 2 000-character name or a
# sparse member at a few bytes of traffic, where a resource bound never would.
#
# What is still NOT covered, measured rather than asserted:
#   * THE READER BOUNDS BYTES, NOT WHAT THEY EXPAND INTO, and the factor is not
#     one number. A sparse chain read in 512-byte blocks becomes tuples costing
#     about three times the bytes (measured 3.05, 2.98, 2.99 at three ceilings).
#     PAX RECORDS ARE FAR WORSE: the intermediate list of raw records runs
#     seventeen to thirty times the bytes read, so the two classes must not be
#     quoted with the same figure — an earlier version of this paragraph gave 3x
#     for both. What keeps the second class bounded is MAX_SINGLE_READ_BYTES,
#     since the expensive shape is one enormous declared read.
#   * A LEGAL ARCHIVE CAN STILL COST TENS OF MEGABYTES. 1024 members each
#     carrying 1370 tiny pax records — every one inside MAX_PAX_HEADER_CHARS,
#     nothing about it irregular — is an 81 KiB body and about 110 MB while
#     parsing, and it is accepted, because each part of it is something a real
#     archive may contain. That is the price of admitting pax headers at all;
#     it is bounded by MAX_MEMBERS x MAX_PAX_HEADER_CHARS x that factor, and it
#     is the number to revisit if either ceiling is ever raised.
#   * SEEKS ARE NOT READS. `tarfile` skips member data by seeking, and the gzip
#     layer below still decompresses it. That is why the survey branch charges
#     `member.size` separately — the two together are what keep a gzip bomb from
#     being free.
MAX_MEMBER_NAME_CHARS = (MAX_PATH_DEPTH * MAX_COMPONENT_CHARS
                         + (MAX_PATH_DEPTH - 1)     # the separators between
                         + len("./"))               # what plain `tar` prefixes

# Ceiling on everything ELSE one entry's header can hang on the TarInfo: `uname`,
# `gname`, and every key and value of `pax_headers`.
#
# ITS OWN NUMBER, deliberately not MAX_MEMBER_NAME_CHARS. The dict holds `path`
# and `linkpath` — the very fields already counted in that sum — so one shared
# ceiling would charge a legal member twice for the same string and refuse it.
#
# Measured, so the number is not a guess. A legal archive's per-entry extra is
# almost entirely the pax `path` key mirroring the name: the system `tar`
# produces at most 558 characters on an ordinary tree (`path` and `mtime`), our
# own client 519, and the longest legal name there is — 1033 characters — makes
# it 1037. So the ceiling has to clear roughly twice MAX_MEMBER_NAME_CHARS, for
# `path` and `linkpath` together, with room for the timestamp keys (`mtime`,
# `atime`, `ctime`) that GNU tar writes in pax format and the `SCHILY.*` an
# xattr-carrying tar adds.
#
# PINNED FROM ABOVE by `test_the_pax_ceiling_admits_the_heaviest_legal_header`,
# which builds the heaviest header a legal push can carry and expects it through.
# Worth saying which way that matters: too LARGE only weakens a memory bound,
# while too SMALL refuses honest pushes and does it only for the widest member
# anybody ever sends — the failure that arrives late and looks like corruption.
#
# Without it: 300 ordinary members with legal names and a megabyte of `uname`
# each are a 315 KB body and 305 MB of process memory — and, unlike the
# `linkname` case, they PUBLISH, because nothing about them is even irregular.
MAX_PAX_HEADER_CHARS = 2 * MAX_MEMBER_NAME_CHARS + 2048

# What a tar stream may weigh ON TOP of the file bytes it carries, and so the
# slack `_CountingReader` gets above `max_build_bytes`.
#
# DERIVED FROM MAX_PAX_HEADER_CHARS, not chosen beside it. A flat 4096 bytes an
# entry looked generous and was not: the pax ceiling admits 4114 CHARACTERS,
# which is already more than that before a single block of framing, so an archive
# breaking no declared rule — 1024 members, the heaviest legal header on each,
# contents inside the ceiling — read to 14 663 680 bytes against a budget of
# 12 582 912 and came back 413. That is precisely the failure the comment beside
# MAX_PAX_HEADER_CHARS warns about, moved sideways into a constant nobody was
# comparing against the other one.
#
# THE UNIT MISMATCH THIS HAD TO SURVIVE: the pax ceiling counts CHARACTERS and
# the wire carries BYTES. A record is `<len> <key>=<value>\n`, so framing alone
# costs about five bytes per one-character key — but a character outside ASCII is
# up to four bytes of UTF-8 on top of that, and nothing in MAX_PAX_HEADER_CHARS
# forbids one. TWO THINGS COMPOUND, and quoting only one of them understates the
# worst case: short keys pay the framing more often, and a wide character pays
# its extra bytes on every one of them. Measured at exactly the ceiling, one
# entry at a time: keys of two to four characters cost 18 944 bytes in ASCII and
# in two-byte BMP alike — at that width the framing dominates — 29 184 in
# three-byte BMP and in astral, and ONE-CHARACTER keys 39 424 in either of those
# last two.
#
# WHAT DECIDES IS UTF-8 BYTE WIDTH, NOT BMP-VERSUS-ASTRAL, and an earlier version
# of this said the opposite: "BMP keys are NOT a step between", 18 944 for all of
# them. True of cyrillic and false of CJK — U+4E00 is three bytes and measures
# exactly like an astral key at every width, the one-character worst case
# included. The expensive shape is a one-character key of three or four UTF-8
# bytes, whichever plane it comes from.
#
# AND THOSE FIGURES CARRY THE STREAM'S OWN PADDING to RECORDSIZE, which one entry
# pays whole and a whole archive pays once. That makes them the right numbers for
# comparing shapes against EACH OTHER — all measured the same way — and the wrong
# ones for comparing against this allowance. The worst entry costs 34 304 bytes
# on its own (512 of pseudo-header, 33 280 of records, 512 for the member's own
# header), which is 152% of the 22 618 a factor of five allows; the padded 39 424
# reads as 174% of it, and quoting that is the same overstatement pointing the
# other way. End to end: a legal archive of 1024 such members read to 35 655 680
# bytes against a budget of 33 646 592 (a 10 MiB build ceiling plus the
# factor-of-five allowance) — 6% over — and answered 413.
#
# Twelve covers the worst case with margin: 51 416 against 34 304, a factor of
# 1.50. The earlier five was reasoned from the framing alone and stated as a
# guarantee no legal archive could outrun, which is exactly the confusion the
# comment two screens up already warns about — named there and walked into here.
PAX_WIRE_BYTES_PER_CHAR = 12
PER_ENTRY_OVERHEAD_BYTES = (
    tarfile.BLOCKSIZE                                  # the member's own header
    + tarfile.BLOCKSIZE                                # padding of its data
    + tarfile.BLOCKSIZE                                # the pax pseudo-header
    + PAX_WIRE_BYTES_PER_CHAR * MAX_PAX_HEADER_CHARS   # the pax payload
    + tarfile.BLOCKSIZE                                # padding of that payload
)
ARCHIVE_OVERHEAD_BYTES = MAX_MEMBERS * PER_ENTRY_OVERHEAD_BYTES


# The fault nearly every refused name has, and the one the message does NOT
# repeat beside each name: the opening sentence of the refusal already states
# the alphabet, so annotating ten names with it is the repetition the message
# exists to avoid. Depth is the rare one and does get said, per name.
ALPHABET_FAULT = "forbidden path component"

# Errno values that mean "this archive's own layout is impossible", as opposed to
# "the disk said no". A member whose parent directory is another member's file, a
# file name already taken by a directory, a component that turned out to be a
# symlink: every one of those is the pusher's problem and gets a 422. Everything
# else — ENOSPC above all — stays an OSError and becomes a 500, per the rule
# `_unpack` spells out. Getting this set wrong in the generous direction is how a
# full volume starts being reported to the pusher as a bad archive.
LAYOUT_ERRNOS = frozenset({errno.EEXIST, errno.ENOTDIR, errno.EISDIR,
                           errno.ELOOP, errno.ENAMETOOLONG})

# Everything a damaged archive can raise once the header has been read. Opening
# the file proves the gzip header is there and nothing else: the member table, the
# per-member data and the gzip CRC are all read lazily, on the iteration and the
# `read()` calls further down, so this set is what actually decides whether a
# truncated upload is a 422 or a 500 with a stack trace.
#
# `gzip.BadGzipFile` is listed by name because it is a subclass of OSError, and
# OSError here means "the DISK failed" — a distinction worth keeping, since one of
# those is the pusher's problem and the other is ours.
CORRUPT_ARCHIVE_ERRORS = (tarfile.TarError, EOFError, zlib.error, gzip.BadGzipFile)

# Copy buffer for extraction. Small enough that the running total below is checked
# often, large enough not to syscall per byte.
CHUNK = 64 * 1024

# Ceiling on ONE read, as opposed to the whole walk.
#
# The two are different questions and conflating them was a hole. A budget for
# the WALK permits any single request that fits in what is left, and at the first
# header that is the entire archive allowance — so `tarfile`, which asks for a
# pax header's DECLARED size in one call, could be told to hand over sixty
# megabytes at once and then parse it into structures costing seventeen to thirty
# times what was read. Measured: a 67.9 KiB body reached 1907.9 MiB, and a
# variant whose records collapse to one dict entry reached 1059.3 MiB and
# PUBLISHED, because the ceiling on the parsed result saw a handful of characters.
#
# THE FLOOR UNDER THIS IS NOT CHUNK, and getting that wrong would be the worst
# shape of failure there is. The extraction loop asks for CHUNK, but it asks
# through a BUFFERED reader, so the request that actually reaches here is the
# larger of CHUNK and whatever buffer size the interpreter uses — measured at
# 65 536 on 3.11 (the image, and CI) and 131 072 on 3.14 (a workstation). That
# number has already moved sixteenfold in one release, and if it ever passes this
# ceiling then EVERY ordinary push is refused, on an upgrade of the base image,
# with a message blaming the archive for something the hub did.
#
# So the floor is measured rather than reasoned about:
# `test_no_ordinary_archive_reads_more_at_once_than_the_ceiling_allows` unpacks a
# real archive, records every request, and fails while there is still a fourfold
# margin — in CI, on the interpreter that ships, long before production.
MAX_SINGLE_READ_BYTES = 16 * CHUNK

# Ceiling on how many reads ONE member's header may take to parse.
#
# The stack, not the heap, is what this defends. A pax pseudo-header's parse ends
# by reading the NEXT header, so a chain of them recurses: four hundred links —
# 1 813 bytes compressed — exhausted the interpreter, and RecursionError is in
# nobody's `except`, so it left as a 500 with a 187 KB traceback. None of the
# other ceilings can see it: chained headers are not members, so the member count
# never rises, and each link is a kilobyte, so neither the single-read ceiling nor
# the walk's budget stirs.
#
# Sixty-four is far above anything honest — a member needs one read for its
# header, and three or four more if it carries a long name or a pax record — and
# far below the depth at which the stack gives out.
MAX_HEADER_READS_PER_MEMBER = 64

# Where the payload digest of a build is remembered, so a retry of the same commit
# can be told apart from a different build claiming the same commit (SPEC 7).
# Dot-prefixed: the file server refuses to serve dot entries.
PAYLOAD_DIGEST_FILE = ".payload.sha256"

# The store of pushed SOURCES, one directory per revision, named by the digest of
# what was pushed. See the module docstring for why it is here and not inside the
# build directory. Not dot-prefixed and it does not need to be: nothing serves
# this tree by path, `builds_of` only ever looks inside `project/`, and a name
# that is plainly visible in a `ls data/` is the honest one for a tree somebody
# will one day go looking for by hand.
SOURCES_DIR_NAME = "sources"
# The pushed body, byte for byte. `.tar.gz` because that is what it IS: the
# request body of the push, unmodified, which is what makes it possible to say
# the code of a revision is the code that built it rather than a repacking of it.
SOURCE_ARCHIVE_NAME = "source.tar.gz"
# The build log, beside the code rather than only at the job (issue #17).
# The job's copy is not going anywhere — no job is ever deleted — but it is
# addressed by a JOB id, which is per attempt and recorded against nothing, so a
# month later the log of a revision is unreachable from the revision. This copy is
# the one half of "how did this revision come about" that would otherwise be
# reachable only by whoever still had the id from the push.
SOURCE_LOG_NAME = "log.txt"

# The project's own title, when somebody has renamed it (`hammerola rename`).
# PROJECT-LEVEL STATE, beside `builds.json` and for the same reason: a title is a
# property of the PROJECT, not of any one build (SPEC 3.1 separates the id from
# the name for exactly this). Renaming could not be done by rewriting the builds
# instead — a published build is immutable and served with a year of `immutable`,
# so the copies already handed out would never see the change and the ones on
# disk would stop matching what was published.
#
# Dot-free, and unreachable from the outside anyway: `_serve_project` only
# accepts a second segment that is a pointer name or passes `valid_build_id`, and
# `SAFE_ID` has no dot in it, so `/project/<pid>/title.json` is a 404 by the same
# rule that makes `builds.json` reachable only because it is spelled out.
PROJECT_TITLE_FILE = "title.json"

# Every transient name the store writes. All dot-prefixed, so none of them is ever
# served or picked up by `builds_of` — which is exactly why nothing notices when
# one is left behind by a SIGKILL, and why they are swept explicitly at startup.
STAGING_PREFIX = ".tmp-"        # a build's OUTPUT, on its way to <pid>/<commit>
LATEST_LINK_PREFIX = ".latest-"  # a symlink about to be renamed over `latest`
UPLOAD_PREFIX = ".upload-"      # one spooled request body, up to MAX_BUILD_BYTES
# The `dev` slot renamed out of the way while a new one takes its name. POSIX
# cannot replace a non-empty directory under a fixed name in one step, so the old
# slot has to go somewhere before the new one can arrive — see `_swap_dev_slot`.
# This is the ONLY thing that parks a directory now: a published build is never
# deleted (see the top of this module), so nothing else ever moves one aside.
TRASH_PREFIX = ".trash-"
JSON_TMP_PREFIX = ".wip-"       # builds.json / index.json mid-write
# One pushed SOURCE tree, from the moment it is unpacked until its build ends.
# At the root and not inside the project directory, and that is deliberate: it is
# not a build, it is never renamed anywhere, and a project directory that exists
# means the project has been pushed to. It also survives the request that created
# it — the worker owns it (src/jobs.py) — so it is the one transient here that is
# expected to outlive its creator.
SOURCE_PREFIX = ".src-"
# The BODY the tree above was unpacked from, from the moment the push is accepted
# until the build says whether the revision was published. The same lifetime as
# `.src-` and the same owner, and it is a second name rather than the spool's
# because ownership changes at exactly that point: `.upload-` belongs to the
# request thread, which deletes it whatever happens, and this belongs to the push.
#
# Kept at all only because a repacked tree is not the same artefact: what makes
# `sources/` worth having is that it holds the bytes that were pushed, and those
# exist only while this file does. It is NOT put beside the unpacked tree, which
# would be the obvious place — the tree is handed to the build as its input, so an
# archive inside it would be one more file the model gets to see and to read.
BODY_PREFIX = ".body-"

LEFTOVER_PREFIXES = (STAGING_PREFIX, LATEST_LINK_PREFIX, UPLOAD_PREFIX,
                     TRASH_PREFIX, JSON_TMP_PREFIX, SOURCE_PREFIX, BODY_PREFIX)

# A leftover younger than this may belong to a publish running RIGHT NOW, in this
# process or another one sharing the volume. An hour is far longer than any push
# takes and short enough that a killed 64 MiB upload does not sit there for days.
#
# `.src-` and `.body-` stretched that assumption and still fit under it, which is
# worth writing down because the next change to either number could break it
# silently: both now live from the request until the build ENDS, so the longest
# either can honestly be in use is the queue wait plus one build —
# jobs.MAX_QUEUED_JOBS times buildproc's `wall_seconds`, divided by the workers.
#
# THAT IS THE ARITHMETIC THAT BROKE, and it broke silently exactly as predicted.
# At 16, 120 s and 2 it was sixteen minutes, comfortably inside the hour. The
# 2026-08-29 raise of `wall_seconds` to 900 s makes it TWO HOURS — past an hour,
# so this sweeper would have deleted the unpacked sources of a build still
# sitting in the queue, and the build would then have failed on a tree that was
# there when it was accepted. Nothing tests this and nothing would have said so;
# the only reason it was caught is that the comment above did the multiplication
# out loud.
#
# Four hours: the two-hour worst case with the same kind of room the hour used to
# give the sixteen minutes. What it costs is the other end — a killed 64 MiB
# upload now sits on the volume for up to four hours instead of one — and that is
# the right side to lose on, because a leftover wastes space while a swept-out
# source loses a build.
LEFTOVER_MAX_AGE_SECONDS = 4 * 3600


class PublishError(Exception):
    """A publish that must be answered with a specific HTTP status.

    Carries the status so app.py does not have to classify failures a second
    time, and a message that is safe to hand back to the pusher — a 422 exists so
    that the person who pushed can see WHICH file was missing.
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class AcceptedPush:
    """A pushed source tree the hub has taken responsibility for.

    `sources` is unpacked and validated; whoever holds this owns that directory
    and has to remove it. `digest` is over those sources, and is the number every
    later "is this the same push?" question is answered with. `commit` is the
    name it will be published under: the segment the caller put in the URL, or —
    on the route that has no such segment — the digest itself (`mint_revision`).

    `archive` is the request body those sources came out of, moved somewhere the
    request thread does not delete. It is owned exactly like `sources` — the same
    holder, removed at the same moment — with one extra ending: a build that
    publishes hands it to `keep_sources` instead, and it is then the code of a
    revision rather than a transient (see the module docstring).
    """

    sources: Path
    archive: Path
    digest: str
    commit: str


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def published_stamp() -> str:
    """When a build arrived, to the millisecond.

    Finer than `utcnow_iso`, and the extra digits are load-bearing rather than
    decorative: `published` is half of the key an open page polls with
    (`commit@published`), and in the local slot it is the ONLY half that moves —
    that slot's `commit` is the constant `dev` for every build it will ever hold
    (SPEC 7.6). Two pushes inside one second are not a human edit-build-look
    loop, but a script that rebuilds on save is exactly that, and a second-
    resolution stamp would leave such a page showing the older of the two for
    good.

    Deliberately NOT a change to `utcnow_iso`: the comment queue stamps `created`
    with it and `?since=` filters that field by STRING comparison against a
    second-resolution timestamp, so widening the format there would quietly move
    the boundary of every such query.
    """
    now = datetime.now(timezone.utc)
    return f"{now:%Y-%m-%dT%H:%M:%S}.{now.microsecond // 1000:03d}Z"


def _build_url(pid: str, name: str) -> dict:
    """The body of a successful publish: where the thing just published lives.

    One URL, for both routes. A commit push answers with its permanent
    `/<commit>/`; a local push answers with `/dev/`, which is the only address a
    local build has ever needed — it is the slot, and the author keeps it open in
    a tab (SPEC 7.6).
    """
    return {"url": f"/project/{pid}/{name}/"}


def _built_key(meta: dict) -> tuple:
    """Sort key for "which build is newest" — `built`, then arrival time.

    `built` is whatever the build wrote; it is not validated beyond being a
    string, so it can be unparseable. An unparseable value sorts oldest instead of
    raising: a build that made it past validation must still be orderable, or one
    malformed timestamp would break the picker for the whole project.
    """
    raw = meta.get("built") or ""
    stamp = 0.0
    try:
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        stamp = parsed.timestamp()
    except (TypeError, ValueError):
        stamp = 0.0
    return (stamp, str(meta.get("published") or ""))


# -- member paths ----------------------------------------------------------
def _member_parts(name: str) -> tuple[list[str], str]:
    """Split one member name into path components. -> (parts, why not, or "").

    `name` is what the archive said with a leading `./` removed, which is what
    actually gets checked. RETURNS the fault instead of raising it, so the walk
    can collect every unusable name in the archive and answer with all of them
    at once (issue #42); `parts` is meaningful only when the fault is
    empty.

    Everything a traversal needs is refused by the component rule alone, and it
    is worth listing which shape dies on which clause, because the whitelist
    reads like it only bans exotic characters:

      * `../evil` and `a/../../b` — a `..` component does not start alphanumeric;
      * `/etc/passwd` and a leading `/` — splitting gives an EMPTY first
        component, and the empty string does not match either;
      * `a//b` — an empty component in the middle, same clause;
      * `a/./b` and a trailing `a/` — `.` and `` again;
      * `a\\..\\b`, a NUL, a non-ASCII lookalike — none of those characters is in
        the class at all.

    So there is no separate list of forbidden shapes to keep in sync with the
    pattern: the pattern IS the list, applied per component.
    """
    parts = name.split("/")
    if len(parts) > MAX_PATH_DEPTH:
        return parts, f"{len(parts)} path components deep"
    for part in parts:
        if not SAFE_COMPONENT.match(part):
            return parts, ALPHABET_FAULT
    return parts, ""


ELLIPSIS = "..."


def _cut_middle(text: str, cap: int) -> str:
    """`text` reduced to AT MOST `cap` characters, with the middle taken out.

    At most rather than exactly, and the guards are why. A `cap` no larger than
    the ellipsis has no middle to keep either side of, and the arithmetic below
    then runs backwards: `text[-0:]` is not the empty string, it is the WHOLE
    string, so a cap of 3 used to return the entire input with `...` in front of
    it — a ceiling that made its argument longer. Unreachable at today's two call
    sites, and left unreachable rather than trusted, because a declared ceiling
    that nothing holds it to is the shape of every other defect in this file.
    """
    if cap <= len(ELLIPSIS):
        return text[:cap]
    keep = cap - len(ELLIPSIS)
    head = keep // 2
    # `tail` is at least 1 for every cap the guard lets through, so there is no
    # second `if` here: a guard plus a fallback for the same case is what made
    # the docstring above describe behaviour the code no longer had.
    tail = keep - head
    return text[:head] + ELLIPSIS + text[-tail:]


def _is_the_disk(error: BaseException) -> bool:
    """Whether a failure raised inside `tarfile` is the FILESYSTEM's, not the archive's.

    THE ONE EXCEPTION TO "CATCH BY FACT". The two broad handlers below refuse by
    WHERE the failure happened rather than by its type, because enumerating types
    is what let a `RecursionError` out as a 500. But `tarfile` reads the body off
    the disk through the gzip layer while it parses, so a genuine read error —
    EIO, and whatever else a failing volume produces — is raised from inside those
    same calls, and answering "your archive is corrupt" to it would send the
    pusher off to debug a file that is fine. That is the rule `_unpack` states
    absolutely, and this is what keeps it absolute.

    THE TEST IS THE SET THAT ALREADY EXISTS rather than a second list of errnos:
    `CORRUPT_ARCHIVE_ERRORS` names `gzip.BadGzipFile` explicitly BECAUSE it is an
    OSError subclass, i.e. it already encodes which OSErrors are the archive's
    doing. Reusing it means the two mechanisms cannot drift apart — a fourth
    archive-shaped OSError added there is understood here on the same commit.
    Everything that is not an OSError at all (TarError, ValueError, RecursionError
    and every type nobody has met yet) stays the pusher's problem.
    """
    return (isinstance(error, OSError)
            and not isinstance(error, CORRUPT_ARCHIVE_ERRORS))


def _members_of(tar, counted):
    """Iterate an archive, turning any failure of the PARSER into a 422.

    BY FACT, NOT BY TYPE, and that is a correction this went through. It began as
    a catch for `ValueError`, because a sparse map whose numbers are not numbers
    raises one — but the type was never the point. A chain of pax pseudo-headers
    RECURSES: four hundred links, 1 813 bytes compressed, exhaust the
    interpreter, and `RecursionError` is not a ValueError, not a TarError, and
    not in CORRUPT_ARCHIVE_ERRORS either, so it left as a 500 with a 187 KB
    traceback about an archive that is plainly the pusher's doing. Enumerating
    exception types fails here for the same reason enumerating TarInfo fields
    did: what decides is WHERE it was raised, and `tarfile` is what runs inside
    these calls.

    IT IS NOT THE ONLY THING RUNNING THERE, which is the qualification the word
    "ANY" used to paper over: `tarfile` reads through the gzip layer, off the
    disk, so a real read failure is raised from inside the same call and would be
    answered as a corrupt archive. `_is_the_disk` is what lets it past, and
    `PublishError` is re-raised untouched for the same kind of reason — the
    counting reader raises one from inside these calls and it already carries the
    right answer.

    WRAPPING THE ITERATION AND NOT THE LOOP BODY is what makes a catch this broad
    safe: around our own code it would swallow our own bugs, which must stay 500s.
    """
    iterator = iter(tar)
    while True:
        # The header-read window: opened here so a chained-header archive is
        # refused before the stack is, and closed straight after so that member
        # DATA — a thousand honest reads for a large file — is never counted.
        counted.begin_header()
        try:
            member = next(iterator)
        except StopIteration:
            return
        except PublishError:
            raise
        except Exception as error:
            if _is_the_disk(error):
                # Not the archive. Let it go up to `_unpack`'s own OSError arm,
                # which logs it and keeps it a 500.
                raise
            raise PublishError(
                422,
                f"archive is corrupt: "
                f"{_shown_untrusted(str(error))}") from error
        finally:
            counted.end_header()
        yield member


class _CountingReader:
    """A read-only file wrapper that refuses past a ceiling of bytes READ.

    THE ANSWER TO "WHICH FIELD DID WE FORGET". Every ceiling above it counts
    something that has already landed on a TarInfo — a name, a link target, a pax
    dict — and finding those took three rounds of review, one field per round,
    because each new one arrived by a route nobody had enumerated. This counts
    what came off the WIRE instead, which is upstream of every field there is and
    of every field a later `tarfile` might grow: header blocks, long-name
    pseudo-members, pax record payloads, sparse chains and member data all pass
    through one `read`.

    It is what closes the case the field ceilings structurally cannot. A pax
    header may DECLARE any size it likes and `tarfile` reads it in one call, so a
    194 KB body could make the process hold 400 MB before any field was
    populated — and worse, a declared size followed by NUL padding parses into a
    single tiny record, so the dict the pax ceiling measures stays small and the
    ceiling never fires at all. Counting the read makes the declaration itself
    the thing that is refused.

    IT DOES NOT REPLACE THE FIELD CEILINGS and they are not redundant beside it,
    because the two answer different questions. This one is a RESOURCE bound: it
    permits anything small. The field ceilings are SEMANTIC — a 2 000-character
    member name and a sparse member are refused at a few bytes of traffic, where
    this reader would never notice them. Each still has its own test.

    Blind spot, stated because it is the reason `member.size` is still counted
    separately: `tarfile` skips over member data by SEEKING, and a seek is not a
    read. The gzip layer below still decompresses it, so the survey branch keeps
    charging declared sizes for exactly that.
    """

    def __init__(self, wrapped, cap: int):
        self._wrapped = wrapped
        self._cap = cap
        self.total = 0
        # The largest single request seen. Nothing enforces anything with it —
        # it is here so a test can MEASURE what the buffered layer above asks
        # for, instead of a comment guessing (see MAX_SINGLE_READ_BYTES).
        self.largest_request = 0
        # Reads spent parsing ONE member's header, and whether we are in that
        # window at all. The window is opened and closed by `_members_of`,
        # because the count must not run while member DATA is being read: a
        # sixty-four-megabyte file is a thousand honest CHUNK reads.
        self.header_reads = 0
        self.parsing_header = False

    def begin_header(self):
        self.header_reads = 0
        self.parsing_header = True

    def end_header(self):
        self.parsing_header = False

    def read(self, size=-1):
        # REFUSED BEFORE THE READ, not after. `tarfile` asks for a pax header's
        # whole declared size in ONE call, so a wrapper that read first and
        # counted afterwards would already be holding the 200 MB it was about to
        # object to — measured, and the peak was identical to having no ceiling
        # at all. Asking about the request rather than the result is the whole
        # difference between a bound and a report.
        if size is None or size < 0:
            # An unbounded read, which nothing on this path performs: every call
            # names a block, a declared header size, or the chunk the extraction
            # loop asks for. Refused rather than guessed at. Capping it silently
            # would be a ceiling nobody could see working, and returning short
            # would corrupt the parse — so if a future `tarfile` starts doing
            # this, it says so instead of quietly changing what is enforced.
            raise PublishError(
                413,
                "this archive asks to be read without a length, which this hub "
                "does not serve")
        if size > MAX_SINGLE_READ_BYTES:
            # The declared-size case. Refused on the REQUEST, so the bytes are
            # never held and the parse that would have turned them into
            # seventeen times as much never starts.
            raise PublishError(
                413,
                f"this archive asks for {size} bytes in one read, more than the "
                f"{MAX_SINGLE_READ_BYTES} this hub reads at a time")
        room = self._cap - self.total
        if size > room:
            raise PublishError(
                413,
                f"the archive reads past {self._cap} bytes once decompressed, "
                f"which is more than this hub unpacks")
        if self.parsing_header:
            self.header_reads += 1
            if self.header_reads > MAX_HEADER_READS_PER_MEMBER:
                # A chain of pseudo-headers. Refused here rather than left to
                # the stack, which is the other thing that ends it — see
                # MAX_HEADER_READS_PER_MEMBER.
                raise PublishError(
                    422,
                    f"one member's header takes more than "
                    f"{MAX_HEADER_READS_PER_MEMBER} reads to parse; this "
                    f"archive chains extended headers")
        self.largest_request = max(self.largest_request, size)
        chunk = self._wrapped.read(size)
        self.total += len(chunk)
        return chunk

    # Everything below is what `tarfile` needs of a file object and nothing more.
    # No `close`: the stream is closed by `_unpack`, which opened it, and a
    # forwarding method here would be a second way to do it that nothing calls.
    def seek(self, *args, **kwargs):
        return self._wrapped.seek(*args, **kwargs)

    def tell(self):
        return self._wrapped.tell()

    def readable(self):
        return True

    def seekable(self):
        return True


def _pax_header_chars(member) -> int:
    """Everything besides name and linkname that one header hangs on a TarInfo.

    That is `pax_headers`, an arbitrary dict of arbitrary strings — `path` and
    `linkpath` among its possible keys — and it is the whole of what has to be
    counted. `uname` and `gname` are the fields that make this ceiling necessary
    (300 members with a megabyte of `uname` each published, at 305 MB of memory),
    but they are NOT summed separately here, and the reason is a property of the
    format rather than of `tarfile`: the ustar and GNU headers give each of them
    a fixed 32-byte field, so a value larger than that can only have arrived as a
    pax record — and is therefore already in this dict, under that same key.
    Measured across all three formats; `test_a_large_owner_name_can_only_arrive_
    as_a_pax_record` is what holds the claim.

    Adding the attributes on top would be a second guard for a case the first one
    already covers — the shape that let `_cut_middle` describe behaviour it did
    not have, and it would be dead code no test could distinguish.
    """
    return sum(len(key) + len(value)
               for key, value in member.pax_headers.items())


def _shown_untrusted(raw_name: str) -> str:
    """One sender-controlled string, cut to size and escaped, fit to print.

    Named for what it guards rather than for its first caller: a member name is
    one such string, and the TEXT OF AN EXCEPTION `tarfile` raised is another —
    `invalid literal for int() with base 10: 'notanumber'` carries the sender's
    own bytes inside it, so interpolating one into a 422 and a log line puts
    them exactly where this function exists to stop them going.

    NEVER LONGER THAN MAX_REFUSED_NAME_CHARS, which is the whole contract and
    the reason the cut happens twice. The first cut is on the RAW name and is
    about work: it keeps `repr()` from building the escaped form of a
    megabyte-long name at all. The second is on the ESCAPED name and is about
    the promise: escaping expands, by as much as ten characters for one astral
    non-printable, so a raw-only cut capped a string nobody prints. Cutting
    escaped text is safe to do blindly — it is already printable ASCII-ish, so
    a cut inside an escape sequence can only shorten it, never uncover a
    control character.
    """
    if len(raw_name) > MAX_REFUSED_NAME_CHARS:
        raw_name = _cut_middle(raw_name, MAX_REFUSED_NAME_CHARS)
    shown = repr(raw_name)
    if len(shown) > MAX_REFUSED_NAME_CHARS:
        shown = _cut_middle(shown, MAX_REFUSED_NAME_CHARS)
    return shown


def _refused_names_error(refused: list, count: int) -> PublishError:
    """The one 422 for every member name this archive cannot have.

    `refused` is (name ALREADY cut and escaped, why not), at most
    MAX_REFUSED_NAMES_REPORTED of them; `count` is how many there really were,
    which is a plain integer precisely so that the ones past the ceiling cost
    nothing to know about. The rule is stated ONCE, in the opening sentence,
    rather than repeated beside each name: with nineteen of them the repetition
    is the message and the list of names is what the pusher has to act on.
    """
    listed = ", ".join(
        shown + ("" if fault == ALPHABET_FAULT else f" ({fault})")
        for shown, fault in refused)
    hidden = count - len(refused)
    return PublishError(
        422,
        f"unsafe archive member names: {count} of them. Every component "
        f"of a member's path must match {SAFE_COMPONENT.pattern}, and a path "
        f"may be at most {MAX_PATH_DEPTH} components deep. Names are escaped "
        f"and cut to {MAX_REFUSED_NAME_CHARS} characters: {listed}"
        + (f", and {hidden} more" if hidden > 0 else "")
        # Said because it is not obvious and it changes what a green retry
        # means: from the first of these onwards the walk only looked at NAMES,
        # so links, duplicates and everything else went unchecked. Fixing the
        # names can therefore be answered by a different refusal rather than by
        # a publish, and that is not the hub changing its mind.
        + ". Nothing else about this archive was checked once the first of "
          "these was found — links and duplicate names among them")


def _open_member_dir(dest_fd: int, parts: list[str], raw_name: str) -> int:
    """Create and open one member's directory chain, one component at a time.

    Returns a descriptor for the directory the member's file belongs in; the
    caller closes it unless it IS `dest_fd`, which the caller owns.

    The whole point is that no path of more than one component is ever handed to
    the kernel. Each component is created with `mkdirat` and then opened with
    `openat` under O_NOFOLLOW|O_DIRECTORY, so a symlink at any level is an ELOOP
    rather than a redirection, and a regular file at any level is an ENOTDIR
    rather than a write into somebody else's file. That is what makes the
    "symlink planted by an earlier member" family of attacks structurally
    impossible rather than merely refused: the archive cannot create a symlink
    (links are rejected outright), and even if something else planted one between
    two members, this walk would not follow it.

    Directories are OURS: mode 0o755, never the mode a directory entry in the
    archive asked for, and created from the paths of the files that need them.
    A pre-existing directory is accepted (EEXIST) because two members of the same
    tree legitimately share a parent.
    """
    current = dest_fd
    for part in parts:
        try:
            os.mkdir(part, 0o755, dir_fd=current)
        except FileExistsError:
            # Already made by an earlier member of this same archive — or
            # already something else entirely, which the open below is what
            # decides. `mkdir` does not follow a symlink at the final component,
            # so a dangling symlink lands here too and is caught one line later.
            pass
        except OSError:
            if current != dest_fd:
                os.close(current)
            raise
        try:
            opened = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current)
        except OSError as error:
            if error.errno in LAYOUT_ERRNOS:
                raise PublishError(
                    422,
                    f"archive member {raw_name!r} cannot be unpacked: {part!r} "
                    f"is not a directory this archive is allowed to write "
                    f"through") from error
            raise
        finally:
            if current != dest_fd:
                os.close(current)
        # On the descriptor, and unconditionally: `mkdir`'s mode argument is
        # filtered through the process umask, so a hub started under `umask 077`
        # would create 0o700 directories and the non-root `app` user would then
        # be unable to READ the build it just published. The files below get the
        # same treatment for the same reason.
        try:
            os.fchmod(opened, 0o755)
        except OSError:
            os.close(opened)
            raise
        current = opened
    return current


def _create_member_file(parent_fd: int, leaf: str, raw_name: str) -> int:
    """Create one member's file inside an already-opened directory. -> fd.

    O_EXCL and O_NOFOLLOW carry the same weight they did while the archive was
    flat. What the tree adds is a NEW way for an archive to be impossible — a
    member `a/b.py` after a member `a`, so the name is taken by a directory — and
    that has to come out as a 422 rather than as an unhandled OSError, which is
    a 500 with a stack trace about an archive that is plainly the pusher's fault.
    """
    try:
        return os.open(
            leaf,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
            0o644,
            dir_fd=parent_fd)
    except OSError as error:
        if error.errno in LAYOUT_ERRNOS:
            raise PublishError(
                422,
                f"archive member {raw_name!r} cannot be created: {leaf!r} is "
                f"already taken by something else in this archive") from error
        raise


class Store:
    """Everything that touches DATA_DIR.

    One instance per process. `max_build_bytes` is passed in rather than read
    from the settings singleton so tests can build a Store on a tmp_path without
    touching the process environment.
    """

    def __init__(self, data_dir, max_build_bytes: int):
        self.root = Path(data_dir).resolve()
        self.max_build_bytes = max_build_bytes
        self.projects_dir = self.root / "project"
        # NOT created here, unlike `projects_dir`. It is created by the first
        # publish that puts something in it, so a hub that has never published a
        # revision has no `sources/` at all — which is what makes "a build that
        # failed leaves nothing behind" an observable fact rather than an empty
        # directory somebody has to interpret.
        self.sources_dir = self.root / SOURCES_DIR_NAME
        # Publication is serialized per project: builds.json and the `latest`
        # symlink are both derived from the full set of builds, so two concurrent
        # pushes to the SAME project could interleave into a builds.json and a
        # pointer that describe different moments. Different projects never touch
        # each other's state and are free to run in parallel.
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        # The root index spans every project, so it gets its own global lock.
        self._index_lock = threading.Lock()
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self._sweep_leftovers()

    # -- leftovers ---------------------------------------------------------
    def _sweep_leftovers(self) -> None:
        """Delete transient entries an earlier run died in the middle of.

        Nothing else ever will. Every name here is dot-prefixed, so `builds_of`
        skips it and the file server refuses to serve it — a SIGKILL during a
        push therefore leaves up to MAX_BUILD_BYTES of spooled body plus a
        half-unpacked staging tree on the volume, permanently.

        Only entries older than an hour are touched, because a concurrent publish
        in this very process is using names of exactly the same shape.
        """
        cutoff = time.time() - LEFTOVER_MAX_AGE_SECONDS
        directories = [self.root]
        try:
            directories += [p for p in self.projects_dir.iterdir() if p.is_dir()]
        except OSError:
            pass
        for directory in directories:
            try:
                entries = list(directory.iterdir())
            except OSError:
                continue
            for entry in entries:
                if not entry.name.startswith(LEFTOVER_PREFIXES):
                    continue
                try:
                    # lstat, not stat: a leftover `.latest-<uuid>` is a symlink
                    # and may already dangle.
                    if entry.lstat().st_mtime > cutoff:
                        continue
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                    else:
                        entry.unlink()
                except OSError as error:
                    logger.warning(f"could not sweep leftover {entry}: {error}")
                    continue
                logger.info(f"swept leftover {entry}")

    # -- naming ------------------------------------------------------------
    @staticmethod
    def valid_pid(pid: str) -> bool:
        return bool(SAFE_ID.match(pid))

    @staticmethod
    def valid_build_id(name: str) -> bool:
        """Is this a name a commit build may be published and served under?

        Only the two reserved names are out. The `dev-` PREFIX is deliberately not
        reserved any more: it used to be, because dev ids were `dev-<digest>` and
        a commit called `dev-1234` would have been filed with the local builds
        rather than with the commit ones. There is no bucket of local builds now
        — there is one slot, with no history — so `dev-1234` is just a commit id
        like any other and gets the same permanent URL.
        """
        return bool(SAFE_ID.match(name)) and name not in RESERVED_BUILD_NAMES

    @staticmethod
    def mint_revision(digest: str) -> str:
        """The name the hub gives a revision it names itself: the payload digest.

        THE IDENTIFIER IS THE CONTENT, and every property the revision route
        needs falls out of that rather than being enforced on top of it:

          * "the same sources are the same revision" is an identity, not a
            check — an unchanged tree cannot be given a second address;
          * "this name is taken by different content" cannot arise, because
            different content hashes to a different name (the 409 that answers
            it survives for the reason `settled` gives, which is about a
            directory that has lost its digest file, not about a colliding id);
          * nothing has to be stored to hand out the next one, so two pushes
            racing each other need no coordination at all.

        NOT TRUNCATED, and that is the one number worth writing down. A sha256
        in hex is exactly 64 characters and `SAFE_ID` allows exactly 64, so the
        whole digest fits with nothing to spare and nothing to gain by cutting
        it: the URL was already carrying 40 hex characters when the id came from
        git, it is pasted rather than typed, and 24 more characters cost
        nothing. A truncated prefix would cost something real — with n published
        revisions and b bits kept, the chance that some pair collides is about
        n²/2^(b+1), so a 64-bit (16-character) prefix over a million revisions is
        ~3e-8. Small, but the FAILURE it buys is not small and not repairable:
        two different source trees would map to one URL, the second would be
        refused 409 for ever, and the pusher has no other name to publish under
        because the pusher does not choose the name any more.

        `digest` comes from `_payload_digest`, so this can only fail if that
        function's output shape changes — base64 (`+`, `/`), a prefix, a longer
        hash. It is checked rather than assumed because the failure would
        otherwise be a directory created under a name the file server refuses to
        serve, i.e. a build that publishes and then 404s.
        """
        if not Store.valid_build_id(digest):
            raise PublishError(
                500,
                "the hub could not name this revision: its digest is not a "
                "usable build id")
        return digest

    def _lock_for(self, pid: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(pid, threading.Lock())

    # -- publish -----------------------------------------------------------
    def upload_path(self) -> Path:
        """A private path under DATA_DIR for one request body.

        On the volume rather than in /tmp: a body is up to MAX_BUILD_BYTES, the
        container's writable layer is not where that belongs, and the dot prefix
        keeps it out of `builds_of` and out of the file server. Swept by
        `_sweep_leftovers` if the process dies before deleting it.

        This name belongs to the REQUEST THREAD, which deletes it whatever
        happens. A body that is accepted leaves under another name — see the
        rename at the end of `accept_sources` — because from that point it is
        owned by the push and may outlive the request by a whole build.
        """
        return self.root / f"{UPLOAD_PREFIX}{uuid.uuid4().hex}"

    # -- accepting a push (in the request thread) ---------------------------
    def accept_sources(self, pid: str, commit: str | None, body_path: Path,
                       body_size: int) -> "AcceptedPush":
        """Unpack one pushed SOURCE tree and hash it. Raises PublishError.

        The first half of what `publish` used to do in one go. It stays in the
        REQUEST because everything it can refuse is a property of the upload
        itself — the ids, the size, the archive — and an archive that is not an
        archive has to be a 4xx on the push, not a job the pusher has to poll to
        find out about. What it deliberately does NOT do is touch the project's
        directory: nothing here is published, and a push that never builds must
        leave no trace of a project that was never pushed to successfully.

        Takes a PATH, not bytes: the body is already on disk by the time it gets
        here, and reading it back into memory to hand it over would undo exactly
        the peak this avoids.

        The digest is of the SOURCES, and it is what tells an identical retry
        from a colliding one from here on. It has to be, now that the hub builds:
        the built output carries the wall clock of the build (`meta.json` and
        `metrics.json` both stamp `built`), so hashing THAT would make every
        rebuild of the same commit a 409 and take away the pusher's ability to
        retry — the exact failure `_payload_digest` already refuses to walk into
        with the rewritten meta.json. What the pusher supplied is the sources; that is
        what "the same push" can honestly mean.

        `commit` is None when the URL carried no name for this push, which is
        how a pusher asks the hub to name the revision: the digest computed here
        BECOMES that name (`mint_revision`). It is the same number either way —
        what changes is only whether it is also the address.
        """
        if not self.valid_pid(pid):
            raise PublishError(422, f"invalid project id: {pid!r}")
        # `dev` is the one commit name the URL may carry that is not a build id:
        # it is the local slot (SPEC 7.6), and it is validated by being exactly
        # that constant rather than by the build-id rule, which reserves it.
        # None is not a name at all — there is nothing to validate until the
        # sources have been hashed, further down.
        if commit is not None and commit != DEV_LINK \
                and not self.valid_build_id(commit):
            raise PublishError(422, f"invalid commit id: {commit!r}")
        if body_size > self.max_build_bytes:
            raise PublishError(
                413, f"body is {body_size} bytes, limit is {self.max_build_bytes}")

        sources = self.root / f"{SOURCE_PREFIX}{uuid.uuid4().hex}"
        sources.mkdir()
        try:
            files = self._unpack(body_path, sources)
            digest = _payload_digest(files)
            name = self.mint_revision(digest) if commit is None else commit
            # LAST, and the order is what decides who owns the body. Until this
            # rename the spool is the request thread's and its `finally` deletes
            # it, which is what every failure above wants; after it, the spool
            # path no longer exists, that same `finally` is a no-op, and the body
            # travels with the push. So an exception between the two can only
            # leave the body where the request was already going to remove it.
            archive = self.root / f"{BODY_PREFIX}{uuid.uuid4().hex}"
            os.rename(body_path, archive)
        except BaseException:
            # Every way out of the block above except the ordinary one,
            # BaseException included: a KeyboardInterrupt here would otherwise
            # leave an unpacked tree that only the hourly sweep would ever
            # remove.
            shutil.rmtree(sources, ignore_errors=True)
            raise
        return AcceptedPush(sources=sources, archive=archive, digest=digest,
                            commit=name)

    def settled(self, pid: str, commit: str,
                digest: str) -> tuple[int, dict] | None:
        """Has this exact push already been published? (status, body), or None.

        Raises PublishError(409) when the name is taken by different content.

        Asked BEFORE a build is queued, which is the whole point: rebuilding a
        commit that is already on disk costs minutes of CPU to arrive at an
        answer that was on disk all along, and answering 200 or 409 from the
        request keeps both of those codes where the pusher already expects them —
        immediately, rather than through a job it would have to poll.

        Not under the project lock, on purpose. It is a read whose answer can
        only go stale in one direction — another push landing the same commit
        between here and the rename — and `publish_built` makes exactly the same
        comparison again, under the lock, where it is authoritative.
        """
        pdir = self.projects_dir / pid
        if commit == DEV_LINK:
            # The slot has no 409: it is overwritten by every push by design
            # (SPEC 7.6). The comparison is here only so an unchanged rebuild
            # does no work — and now that the hub builds, "no work" means the
            # build itself, not just the swap.
            if _read_digest(pdir / DEV_LINK) == digest:
                logger.info(f"publish {pid}/{DEV_LINK}: identical, kept")
                return 200, _build_url(pid, DEV_LINK)
            return None

        final = pdir / commit
        if not final.exists():
            return None
        existing = _read_digest(final)
        if existing is not None and existing == digest:
            logger.info(f"publish {pid}/{commit}: identical retry, kept")
            return 200, _build_url(pid, commit)
        # The build directory is immutable and was served with a one-year
        # immutable cache, so silently replacing it would make every cached copy
        # a lie (SPEC 7).
        #
        # STILL REACHABLE ON A MINTED NAME, which is worth saying because the
        # arithmetic looks like it cannot be. When the hub names the revision the
        # name IS this digest, so "same name, different content" would take a
        # sha256 collision — but that is not the only way to get here. The other
        # way is a directory at that name whose `.payload.sha256` is missing or
        # unreadable, and `data/` is a volume every build can write anywhere in
        # (SPEC 8A.4): a half-written directory, a file removed by another
        # build, an unlink that lost its race. There is nothing to compare
        # against then, and answering 200 would claim a publication that may
        # never have finished. On the NAMED route — the one a caller still uses
        # with an id of its own — this is the ordinary case it always was.
        raise PublishError(
            409, f"build {commit} already exists with different content")

    def build_staging(self, pid: str, commit: str) -> Path:
        """Where a build writes: the directory that becomes `<pid>/<commit>`.

        Returned rather than created, because the build creates it itself (see
        `cadbuild.build`, which insists on a clean output directory). What this
        DOES create is the project directory, which has to exist before anything
        inside it can be renamed into place.

        Inside the project directory and not beside the sources, so publication
        is a rename within one filesystem directory — the atomic step the whole
        of SPEC 7.2 rests on.
        """
        pdir = self.projects_dir / pid
        pdir.mkdir(parents=True, exist_ok=True)
        return pdir / f"{STAGING_PREFIX}{commit}-{uuid.uuid4().hex}"

    # -- publishing what a build produced (in a worker thread) --------------
    def publish_built(self, pid: str, commit: str, staging: Path, names,
                      digest: str) -> tuple[int, dict]:
        """Put one built tree at `<pid>/<commit>`. Returns (status, response).

        201 published, 200 identical retry, 409 same commit / different content.
        Anything else is raised as PublishError.

        `staging` is the directory the build wrote into and `names` are the files
        it declared it ships (`BuildOutcome.files`, every one of them already
        checked by the parent to be a regular file under `staging`). The caller
        owns `staging`: on the success path it is renamed away and there is
        nothing left, and on every other path the caller removes it.
        """
        files = _hash_output(staging, names)
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            pdir.mkdir(parents=True, exist_ok=True)
            final = pdir / commit

            # The same comparison `settled` already made in the request, made
            # again here because THIS is the one that is authoritative: it is
            # under the project lock and immediately before the rename, so a
            # second push of the same commit that arrived while this one was
            # building cannot slip between the two.
            if final.exists():
                existing = _read_digest(final)
                if existing is not None and existing == digest:
                    logger.info(f"publish {pid}/{commit}: identical retry, kept")
                    return 200, _build_url(pid, commit)
                raise PublishError(
                    409, f"build {commit} already exists with different content")

            meta = self._finish_staging(pid, commit, staging, files, digest)
            try:
                os.rename(staging, final)
            except OSError as error:
                # Lost a race with another writer, or the directory appeared
                # between the check above and here. Re-run the same comparison
                # rather than reporting a filesystem error the pusher cannot act on.
                if not final.exists():
                    raise PublishError(
                        422, f"could not publish build: {error}") from error
                existing = _read_digest(final)
                if existing is not None and existing == digest:
                    return 200, _build_url(pid, commit)
                raise PublishError(
                    409,
                    f"build {commit} already exists with different content",
                ) from error

            # PAST THE POINT OF NO RETURN. The rename above IS the publication
            # (SPEC 7.2): the build is at its permanent URL and anyone can
            # already fetch it. Everything from here on is bookkeeping DERIVED
            # from what is now on disk — which build `latest` names, what the
            # picker lists, what the index shows — and every one of those is
            # recomputed from scratch by the next publish of this project, so a
            # failure is recoverable and a lie is not. Reporting failure here
            # would tell the pusher the push did not land
            # while its URL serves the build; since step 5 it would also mark a
            # job `failed` for a build that is live, which is the worst answer
            # available.
            #
            # RECOVERABLE IS NOT REPAIRED, and the difference is worth being
            # exact about. What repairs it is the next publish OF THIS PROJECT
            # and nothing else: startup recomputes none of this, and another
            # project's publish never touches these files. So a project that was
            # pushed to once and then abandoned keeps whatever this leaves —
            # `latest` on the previous build, a picker missing the newest one —
            # for as long as nobody pushes to it again, which for an abandoned
            # project is for ever.
            #
            # Order still matters on the success path: the symlink moves first,
            # so a reader following `latest` is on the new build before the
            # picker starts offering it, and the picker is written last, from
            # what is on disk once the pointer has settled.
            try:
                # A rename is superseded by the push that follows it: the build
                # carries the project's own title, and that is the newer
                # statement of what the project is called. Before the picker is
                # written, so the file is rebuilt from the state that survives.
                self.clear_title(pid)
                self._switch_latest(pid)
                self._write_builds_json(pid)
            except Exception:
                logger.exception(
                    f"publish {pid}/{commit}: the build is published, but the "
                    f"bookkeeping after it did not finish; the next publish of "
                    f"this project rebuilds all of it")

        try:
            self._refresh_index()
        except Exception:
            logger.exception(
                f"publish {pid}/{commit}: the build is published, but the site "
                f"index was not refreshed")
        logger.info(
            f"publish {pid}/{commit}: {len(files)} files, "
            f"{len(meta['views'])} views")
        return 201, _build_url(pid, commit)

    def publish_dev_built(self, pid: str, staging: Path, names,
                          digest: str) -> tuple[int, dict]:
        """Overwrite the project's ONE local slot, `<pid>/dev/` (SPEC 7.6).

        The author is editing model.py on a laptop and wants to see the result
        now, without committing. That work has no commit to be addressed by, and
        — the part that decides this whole design — it has no history worth
        keeping either: attempt seventeen of an evening is not a version of the
        project, it is the working copy as it stands. So there is exactly one
        slot, like there is exactly one `latest`, and every push rewrites it.

        Rewriting a URL in place is only safe because that URL is served
        `no-cache`, which is what buys the simplicity: no minted ids, no local
        entries in `builds.json`. The commit route keeps its 409 and its year of
        `immutable` untouched — the two never meet.

        Returns 201 when the slot changed and 200 when the same sources are
        already in it — the second answer normally comes from `settled` before a
        build is even queued, and is repeated here for the push that arrived
        while an identical one was building.
        """
        files = _hash_output(staging, names)
        pdir = self.projects_dir / pid
        url = _build_url(pid, DEV_LINK)
        with self._lock_for(pid):
            pdir.mkdir(parents=True, exist_ok=True)
            if _read_digest(pdir / DEV_LINK) == digest:
                # Same sources as the slot already holds. Nothing to write, and
                # nothing SHOULD be written: a swap here would take the page the
                # author has open through a needless re-render.
                logger.info(f"publish {pid}/{DEV_LINK}: identical, kept")
                return 200, url
            meta = self._finish_staging(pid, DEV_LINK, staging, files, digest)
            self._swap_dev_slot(pdir, staging)

            # `latest` is not touched: a local build is not a commit, so it
            # cannot be the newest one. `builds.json` is rewritten because the picker shows
            # whether the slot is occupied at all — and, like the tail of
            # `publish_built`, it runs AFTER the swap that publishes and so
            # cannot be allowed to unpublish it by raising. The next push
            # rewrites the file from scratch.
            try:
                # Same as the commit route: this push carries the project's own
                # title, so an earlier rename has been answered.
                self.clear_title(pid)
                self._write_builds_json(pid)
            except Exception:
                logger.exception(
                    f"publish {pid}/{DEV_LINK}: the slot is published, but the "
                    f"build picker was not rewritten")

        # The site index too, and this is the one thing a local push changes
        # about the front page. The card still describes the newest COMMIT and
        # never the slot (SPEC 7.6) — what it gains is the `dev` chip, i.e. that
        # a slot exists. Without this line that chip appears only when the
        # project is next committed, which is the same class of staleness the
        # picker is rewritten to avoid; with it, a local push costs one index
        # rebuild, which is nothing beside the build that produced the push.
        #
        # OUTSIDE the project lock and after it, and guarded, exactly like
        # `publish_built`: `_refresh_index` takes the index lock and walks every
        # project, so holding a second lock across it is how two publishes to two
        # projects would deadlock — and it runs after the swap that publishes, so
        # it must not be able to turn a published slot into a failed push.
        try:
            self._refresh_index()
        except Exception:
            logger.exception(
                f"publish {pid}/{DEV_LINK}: the slot is published, but the site "
                f"index was not refreshed")

        logger.info(
            f"publish {pid}/{DEV_LINK}: {len(files)} files, "
            f"{len(meta['views'])} views")
        return 201, url

    @staticmethod
    def _swap_dev_slot(pdir: Path, staging: Path) -> None:
        """Put a freshly unpacked tree into `<pid>/dev/`, replacing what is there.

        POSIX has no way to atomically replace a non-empty DIRECTORY under a fixed
        name — `rename` onto a directory only succeeds if the target is empty —
        so this is two renames with nothing between them: the old slot is moved
        aside whole, the new one takes the name, and only then are the old bytes
        deleted. That is deliberately NOT "empty the slot, then unpack into it":
        the difference is that a reader is never inside a directory that is being
        filled, which is the failure that actually matters. It can, for the width
        of one syscall, find the name absent — the price of the slot BEING the
        build rather than a symlink to one, and the reason `latest`, which has to
        survive being pasted into chat, is a symlink instead.

        If the second rename fails the old slot is put back, so a failed push
        leaves the author looking at what they had rather than at a 404.
        """
        slot = pdir / DEV_LINK
        parked = pdir / f"{TRASH_PREFIX}{uuid.uuid4().hex}"
        occupied = os.path.lexists(slot)
        if occupied:
            os.rename(slot, parked)
        try:
            os.rename(staging, slot)
        except OSError:
            if occupied:
                os.rename(parked, slot)
            raise
        if occupied:
            shutil.rmtree(parked, ignore_errors=True)

    # -- the code of a revision --------------------------------------------
    def source_archive(self, revision: str) -> Path:
        """Where one revision's pushed body lives. It may not be there.

        Existence of THIS file is what "the hub has the code of that revision"
        means, and the log below is not part of the question: a directory holding
        only a log is what a rename killed half way through leaves, and it must
        read as absent rather than as half a revision.
        """
        return self.sources_dir / revision / SOURCE_ARCHIVE_NAME

    def source_log(self, revision: str) -> Path:
        """Where the build log of one revision lives. It may not be there."""
        return self.sources_dir / revision / SOURCE_LOG_NAME

    def keep_sources(self, digest: str, archive: Path) -> bool:
        """Store the body of a push as the code of the revision it published.

        True when this call is what put it there. False when the archive was
        already stored, which is the ordinary outcome of publishing the same
        sources a second time and is not an error: the address is the digest of
        the SOURCES, so what is already there unpacks to the very tree this body
        does. The two bodies need not be byte-identical to each other — the same
        tree tarred twice differs in its gzip header alone — and the one kept is
        the one that got there first, which is the only choice that keeps a
        stored archive from changing under a revision that is already published.

        The caller still owns `archive` either way — on the False path it is
        untouched, and on the True path it has been renamed away, so the caller's
        unconditional cleanup finds nothing and does nothing.

        NOT ATOMIC AS A PAIR, deliberately: the directory is created first and
        the body is renamed into it second, so a hub killed between the two
        leaves an empty directory. That reads as "no code for this revision"
        (see `source_archive`) and the next publish of the same sources fills it
        in, so nothing has to collect it — which is the whole reason the failure
        is arranged this way round rather than through a staging name that would
        need sweeping.
        """
        target = self.sources_dir / digest / SOURCE_ARCHIVE_NAME
        if target.exists():
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        # On the descriptor-less path, but for the same reason `_open_member_dir`
        # does it on one: `mkdir`'s mode is filtered through the process umask,
        # so a hub started under `umask 077` would create a directory it can
        # write and nothing else can read.
        os.chmod(target.parent, 0o755)
        os.rename(archive, target)
        os.chmod(target, 0o644)
        return True

    def keep_build_log(self, digest: str, raw: bytes) -> None:
        """Put the build log beside the code of a revision. Bytes, already capped.

        Bytes rather than text because the ceiling belongs to whoever captured
        the log (`jobs.MAX_LOG_BYTES`, derived from what a build is allowed to
        print), and applying a second, different one here is how the two would
        drift into disagreeing about the same file.

        Written only into a directory that already holds the code. A log on its
        own would be a revision this store cannot answer for — and on the one
        path that gets here, `keep_sources` has just run.

        The temporary file goes at the DATA ROOT rather than beside the target,
        for the reason `atomic_write_bytes` spells out: `_sweep_leftovers` walks
        the root and the project directories, so that is where a `.wip-` left by
        a killed write is actually collected. Beside the target it would sit in
        `sources/<digest>/` for the life of the volume.
        """
        directory = self.sources_dir / digest
        if not directory.is_dir():
            return
        atomic_write_bytes(directory / SOURCE_LOG_NAME, raw, tmp_dir=self.root)

    # -- unpacking ---------------------------------------------------------
    def _unpack(self, body_path: Path, dest: Path) -> dict:
        """Extract the archive into `dest`, refusing anything unusual.

        Deliberately NOT `tar.extractall(filter="data")`. That filter exists (it
        was backported to 3.11.4, and the image's python has it), but relying on
        it would make this depend on a runtime detail we do not pin, and it
        permits things we do not want at all — it merely CLAMPS permissions and
        strips special files, where we refuse the whole push. What is written
        here is a whitelist: a member has to be a regular file whose name is a
        relative path of `SAFE_COMPONENT` components, or nothing is published.

        Refusing rather than skipping is the point. A skipped member produces a
        build that is missing a file and looks fine, and the meta.json check
        further down would then fail with a confusing message about a broken
        link; refusing names the actual problem.
        """
        # The gzip layer is opened separately from the tar one so a counting
        # reader can sit BETWEEN them: above the decompression, so what it counts
        # is decompressed bytes, and below `tarfile`, so everything the parser
        # pulls in — header blocks, long-name pseudo-members, pax payloads,
        # sparse chains — goes through it. `mode="r:"` because what it is handed
        # is already an uncompressed tar stream.
        files: dict[str, str] = {}
        # `gzip.open` IS THE ONE LINE OUTSIDE THE BLOCK, because it is the line
        # that creates the thing the block has to release, and there is nothing
        # to close until it returns. Everything else of ours is INSIDE — the
        # reader's constructor included, which used to sit here beside it. That
        # was a leak: it is the `finally` below that closes the stream, so an
        # exception between the open and the `try` left the stream and its
        # descriptor open in a process that stays up for weeks, which is the
        # exact failure owning the stream was meant to end. Nothing in that
        # constructor can raise today; it is inside anyway, because "unreachable"
        # is not a property this file gets to rely on.
        #
        # `gzip.open` reads nothing here — the gzip header is parsed lazily on
        # the first read — so the only way this line fails is the open itself,
        # which is the disk and therefore a 500. BEING OUTSIDE THE BLOCK IS NOT
        # A REASON TO GO UNATTRIBUTED, so it carries a narrow arm of its own
        # instead. It is the first touch of the filesystem in this function and
        # it fails in the ordinary ways: EMFILE/ENFILE while several pushes are
        # unpacked at once (MAX_CONCURRENT_PUBLISHES), EIO on a volume that is
        # going, ENOENT if the spool went away underneath us. ENOSPC is the one
        # that does NOT arrive here, since this is an open for reading. Without
        # the arm, exactly one kind of disk failure in `_unpack` would reach the
        # log as a bare traceback while every other kind named the file and the
        # cause — the same gap, one line up, that widening the arm below closed.
        # It says "failed on the filesystem" like that arm on purpose, so one
        # grep finds every unpack that died on the disk rather than on the
        # archive.
        try:
            stream = gzip.open(body_path, "rb")
        except OSError as error:
            logger.error(
                f"opening {body_path} failed on the filesystem: {error}")
            raise
        # ONE `finally` over the whole thing, because the gzip stream is OURS to
        # close: a TarFile releases only a file object it opened itself, so
        # handing one in moved this from explicit release to whenever the
        # collector happens to get to it. That is invisible until the day
        # something keeps a reference to the tarball — one traceback frame held
        # by a log handler is enough — in a process that stays up for weeks.
        try:
            counted = _CountingReader(
                stream, self.max_build_bytes + ARCHIVE_OVERHEAD_BYTES)
            # The window has to be open HERE as well, not only in `_members_of`:
            # `TarFile.__init__` parses the FIRST member, so a chain of
            # pseudo-headers at the head of the archive is consumed before the
            # walk ever begins — and was, uncounted, until a test for the ceiling
            # found it accepted at seventy-four links.
            counted.begin_header()
            try:
                tar = tarfile.open(fileobj=counted, mode="r:")
            except PublishError:
                # The counting reader's own refusal, already the right answer.
                raise
            except Exception as error:
                # BY FACT, NOT BY TYPE, exactly as in `_members_of` and for the
                # same reason: opening READS — `TarFile.__init__` parses the
                # first header — so every way the parser can fail arrives here
                # too, RecursionError from a chain of pseudo-headers included.
                # `tarfile` is the only thing running inside this narrow block,
                # which is why it is only this call and not the lines around it.
                # The gzip layer it reads THROUGH is the one qualification, and
                # `_is_the_disk` is what carries a real read failure on out — to
                # the `except OSError` arm below, which is why that arm sits on
                # the OUTER block rather than around the extraction alone.
                if _is_the_disk(error):
                    raise
                raise PublishError(
                    422,
                    f"body is not a gzipped tar: "
                    f"{_shown_untrusted(str(error))}") from error
            # NOT A `finally`, and that is the whole reason this line is here
            # rather than four lines up. A `finally` runs with an exception
            # already in flight and anything raised inside it REPLACES that
            # exception — so a body that is simply not a tar, already answered by
            # name with a 422, would come back a 500 about the filesystem. Today
            # nothing in `end_header` can raise: it assigns `False` to a flag.
            # But that is the same "unreachable" the reader's constructor above
            # deliberately does not lean on, and two adjacent blocks cannot live
            # by opposite rules — so this one is closed rather than excused, and
            # closing it costs nothing: every arm above raises, so the only way
            # past them is with `tar` bound, which is exactly when the window has
            # to close. `_members_of` keeps its `finally` because there it earns
            # its keep — the window closes on the `StopIteration` return too, and
            # that last window is the one a test measures.
            counted.end_header()

            # Resolved once: every member's landing spot is compared against this.
            real_dest = os.path.realpath(dest)
            try:
                self._extract_members(tar, counted, dest, real_dest, files)
            except CORRUPT_ARCHIVE_ERRORS as error:
                # The open() above only proved there was a gzip header. Everything
                # else — the member table, each member's data, the trailing CRC — is
                # read here, so a truncated body or a member that lies about its size
                # fails at THIS point, and it is still an unusable upload rather than
                # a bug in the hub. Without this it left as a 500 and a stack trace,
                # and the pusher was told `{"error": "internal error"}` about an
                # archive of its own making.
                raise PublishError(
                422, f"archive is corrupt: {_shown_untrusted(str(error))}") from error
        except OSError as error:
            # Deliberately NOT turned into a 422. This is the disk saying no —
            # ENOSPC above all — and answering "your archive is bad" would send
            # the pusher off to debug a file that is fine while the volume
            # quietly fills up.
            # BOTH DIRECTIONS land here: writing the extracted file, and READING
            # the body, which the parser does through the gzip layer inside the
            # broad catches above. Those refuse by fact rather than by type, so
            # `_is_the_disk` is what hands a read error on to this arm instead of
            # dressing it up as a corrupt archive.
            # WRAPPED AROUND THE WHOLE BLOCK for exactly that second direction.
            # It used to sit on the extraction alone, and a read error raised
            # while `tarfile.open` parsed the FIRST header therefore went past
            # it. NOT into silence, though — that is what this comment used to
            # claim and it was never true: `accept_sources` is called inside a
            # `try` in `app.py` whose `except Exception` logs the traceback under
            # "publish <target> failed", so an OSError from here has always been
            # recorded. What this arm buys is ATTRIBUTION, which is the half of
            # it that does any work: one line naming `dest` and saying the
            # filesystem is what refused, instead of a stack the reader has to
            # work through to decide whether the volume is dying or the hub has a
            # bug. `PublishError` is not an OSError, so nothing this block
            # answers deliberately is swallowed on the way.
            logger.error(
                f"unpacking into {dest} failed on the filesystem: {error}")
            raise
        finally:
            stream.close()

        if not files:
            raise PublishError(422, "archive is empty")
        return files

    def _extract_members(self, tar, counted, dest: Path, real_dest: str,
                         files: dict) -> None:
        """The member loop of `_unpack`. Fills `files` with path -> sha256.

        Split out so its caller can wrap the WHOLE walk — iteration and reads
        included, not just the open — in one place, and so `files` is still
        readable for the caller after a failure.

        Keys of `files` are the member's RELATIVE PATH with `/` separators, not a
        bare name: two files called `part.step` in different directories are two
        different members and have to hash as two.
        """
        total = 0
        # Folded PATH -> the path that claimed it, for the message below.
        seen_names: dict[str, str] = {}
        # Member names this archive cannot have, as (name ALREADY cut and
        # escaped, why not) — and separately how many there were. Collected
        # instead of raised, so one 422 names every one of them (issue #42).
        # The first one also turns the rest of this walk into a SURVEY: the
        # push is refused whatever else is in the archive, nothing more is
        # extracted, and the only thing left worth learning is which OTHER names
        # have to change. That is why no check below this one runs once the
        # count is non-zero — a link or a duplicate further down would otherwise
        # raise and throw away the list that was the point of collecting it.
        #
        # The list stops growing at MAX_REFUSED_NAMES_REPORTED while the counter
        # does not: what is past the ceiling will never be printed, and holding
        # it would be memory the sender chose the size of.
        refused: list[tuple[str, str]] = []
        refused_count = 0
        # The staging directory, held open for the whole walk. Every directory
        # and every file below is opened RELATIVE to this descriptor, so the
        # kernel never resolves a path of ours from the root and there is no
        # prefix for anything to have swapped underneath us.
        dest_fd = os.open(dest, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with tar:
                for index, member in enumerate(_members_of(tar, counted)):
                    if index >= MAX_MEMBERS:
                        raise PublishError(
                            422, f"archive has more than {MAX_MEMBERS} members")

                    # Before anything looks at the name, including whether the
                    # entry is a directory: what this bounds is what `tarfile`
                    # has ALREADY read and is now holding, and it holds a
                    # directory entry's name exactly like a file's.
                    #
                    # RAISED rather than collected, unlike every other thing
                    # wrong with a name. Collecting means reading on, and
                    # reading on is exactly what this is here to stop: an
                    # archive of a thousand such names would be a gigabyte held
                    # in the process that serves the site. The name is not
                    # echoed back for the same reason.
                    #
                    # `linkname` is in the SUM, not a check of its own: it is the
                    # same kind of field arriving by the same mechanism, and it
                    # rides on ordinary files as happily as on links. A SUM
                    # rather than two ceilings because what is being bounded is
                    # what this one entry can make the process hold, and that is
                    # the two fields together.
                    #
                    # Nothing is repeated back — that is the point of the
                    # ceiling. What IS said is the position and the kind, because
                    # both are ours rather than the sender's, and without them
                    # the refusal names nothing at all and cannot be acted on.
                    kind = "directory entry" if member.isdir() else "member"
                    if (len(member.name) + len(member.linkname)
                            > MAX_MEMBER_NAME_CHARS):
                        raise PublishError(
                            422,
                            f"the name of {kind} number {index} (counting from "
                            f"zero), with its link target, is longer than "
                            f"{MAX_MEMBER_NAME_CHARS} characters — longer than "
                            f"any name this hub can accept")
                    # The fourth field, and the one no ceiling can measure: a
                    # sparse map is a list of tuples, not text. Checking the
                    # FIELD is what reaches every route that gets as far as
                    # here, the repeated pax records `_pax_header_chars` cannot
                    # see among them.
                    #
                    # "Every route" is narrower than it first reads, and the
                    # difference is worth keeping: a HOSTILE map need not reach
                    # this line at all, because the parser can choke on it first
                    # — a map whose numbers are not numbers raises inside
                    # `tarfile`, and `_members_of` is what turns that into a 422
                    # instead of a 500. This check is for the maps that parse.
                    #
                    # REFUSED RATHER THAN CAPPED, and the justification had to be
                    # corrected once, so it is worth stating exactly. It is NOT
                    # that only a special flag produces these: bsdtar — the `tar`
                    # on the machine this is developed on — detects holes BY
                    # ITSELF and writes a sparse member with no flags at all,
                    # which `test_a_sparse_member_from_the_system_tar_is_refused`
                    # pins. What holds is narrower and still enough: a model's
                    # sources are small text files, so a hole in one is not
                    # something a real push contains, and this project's own
                    # client packs with `tarfile`, which never writes a sparse
                    # member. So the cost of refusing is an error message for a
                    # tree nobody has, and the alternative is a bound on
                    # something the reader can only cap at three times its
                    # budget. The message names the path for that reason: an
                    # author who does have one gets told which file it is.
                    if member.sparse is not None:
                        raise PublishError(
                            422,
                            f"{kind} number {index} (counting from zero), "
                            f"{_shown_untrusted(member.name)}, is a sparse "
                            f"member; this hub does not accept them")
                    # The third field of the same nature, and the one that
                    # publishes rather than merely being read (see
                    # MAX_PAX_HEADER_CHARS).
                    if _pax_header_chars(member) > MAX_PAX_HEADER_CHARS:
                        raise PublishError(
                            422,
                            f"the header of {kind} number {index} (counting "
                            f"from zero) carries more than "
                            f"{MAX_PAX_HEADER_CHARS} characters of names and "
                            f"pax fields — more than any archive this hub can "
                            f"accept carries")

                    name = member.name
                    if name.startswith("./"):
                        name = name[2:]

                    # `tar -czf build.tar.gz .` is the obvious way to build this
                    # archive, and it stores an entry for the directory itself
                    # (`.`) and one for every subdirectory. Those entries are
                    # skipped without comment — and, more to the point, the
                    # directories are created by US, from the paths of the FILES
                    # that need them, with our own mode. A directory entry is
                    # therefore never trusted for its name, its mode or its
                    # existence: an archive that lists `scripts/` and an archive
                    # that only lists `scripts/gen.py` unpack identically.
                    if member.isdir():
                        continue

                    # Name first: an absolute path, a `..` hop, an empty
                    # component or a `.` component can never match the
                    # whitelist, so traversal is refused before the member type
                    # is even looked at.
                    parts, fault = _member_parts(name)
                    if fault or refused_count:
                        # SURVEYING, and the badly-named member goes through
                        # here too — that is the whole reason this is one branch
                        # and not two. `tarfile` reaches the next header by
                        # decompressing past a member's data whether anyone
                        # reads it or not, so the size ceiling is the only thing
                        # bounding the work a gzip bomb can make a survey do,
                        # and counting only the WELL-named members left it at
                        # zero for the archive where every name is bad. Measured
                        # before it was: a 1 MB body decompressed to 1.07 GB and
                        # answered 422 rather than 413.
                        total += member.size
                        if total > self.max_build_bytes:
                            raise PublishError(
                                413,
                                f"archive expands beyond "
                                f"{self.max_build_bytes} bytes")
                        if fault:
                            refused_count += 1
                            if len(refused) < MAX_REFUSED_NAMES_REPORTED:
                                # Cut and escaped HERE, so what this list holds
                                # is printable and bounded by construction. It
                                # frees no memory — `tarfile` is holding the
                                # whole name either way, and
                                # MAX_MEMBER_NAME_CHARS is what bounds THAT.
                                refused.append(
                                    (_shown_untrusted(member.name), fault))
                        continue

                    # Then the type. A symlink or a hardlink pointing outside
                    # would be a write outside the build directory; a device,
                    # fifo or directory is simply not something a build contains.
                    if member.issym() or member.islnk():
                        raise PublishError(
                            422,
                            f"archive member {name!r} is a link; links are refused")
                    if not member.isfile():
                        raise PublishError(
                            422,
                            f"archive member {name!r} is not a regular file "
                            f"(type {member.type!r})")
                    # Case-INSENSITIVELY and over the WHOLE path, which is not
                    # pedantry on either count: the check decides whether two
                    # members can land on one filesystem, and APFS and a Docker
                    # Desktop bind mount both fold case. `data.json` plus
                    # `DATA.JSON` passed an exact-match check, then hit the
                    # O_EXCL below and turned an unusable archive into a 500 with
                    # a stack trace — on macOS, i.e. exactly where `make test`
                    # runs. Folding only the last component instead of the path
                    # would call `a/model.py` and `b/model.py` a collision, which
                    # they are not; folding the path catches `a/File` against
                    # `A/file`, which they are.
                    folded = "/".join(parts).lower()
                    if folded in seen_names:
                        raise PublishError(
                            422,
                            f"archive member {name!r} appears twice (names are "
                            f"compared case-insensitively over the whole path: "
                            f"the filesystem may not tell {name!r} from "
                            f"{seen_names[folded]!r})")

                    source = tar.extractfile(member)
                    if source is None:
                        raise PublishError(
                            422,
                            f"archive member {name!r} has no readable content")

                    digest = hashlib.sha256()
                    target = dest.joinpath(*parts)
                    # Second, INDEPENDENT line of defence. The name whitelist
                    # above is the primary control, but it is one regexp: relax
                    # it by a character in some future edit and traversal is
                    # back. This asks the only question that actually matters —
                    # where would the write land — of the filesystem rather than
                    # of the string. realpath collapses `..` and follows symlinks
                    # over the WHOLE prefix, so a member whose parent directory
                    # is a symlink out of staging is refused here even though its
                    # own name is impeccable. "Inside" rather than the old
                    # "directly in", because the archive is a tree now — which is
                    # exactly the edit that could have quietly become
                    # `startswith(real_dest)` and accepted `<staging>-evil/`.
                    real_target = os.path.realpath(target)
                    if not real_target.startswith(real_dest + os.sep):
                        raise PublishError(
                            422,
                            f"archive member {member.name!r} would be written "
                            f"outside the build directory")

                    # Third: the walk itself, which is the one that cannot be
                    # raced. Every component is created and opened one at a time
                    # with O_NOFOLLOW|O_DIRECTORY relative to the previous one,
                    # so a symlink anywhere along the path is an error rather
                    # than a redirection — including one planted a microsecond
                    # ago by something outside this process.
                    parent_fd = _open_member_dir(dest_fd, parts[:-1], member.name)
                    try:
                        # O_EXCL: never write over something already at that
                        # name. O_NOFOLLOW: never follow a symlink sitting at
                        # that name — which closes the same hole a moment later
                        # than realpath does, but atomically, so the two together
                        # leave no window.
                        fd = _create_member_file(parent_fd, parts[-1], member.name)
                    finally:
                        if parent_fd != dest_fd:
                            os.close(parent_fd)
                    # The header's `size` is attacker-controlled, so the ceiling
                    # is applied to the bytes actually written, not to what it
                    # claims.
                    try:
                        out = os.fdopen(fd, "wb")
                    except BaseException:
                        # `fdopen` adopts the descriptor only once it has
                        # succeeded; if it raises, nothing owns `fd` any more and
                        # nothing will ever close it — one leaked descriptor per
                        # member, on a process that also serves every read.
                        #
                        # `app._nonblocking` argues against this exact shape and
                        # both are correct: an opener is owned by `FileIO` on
                        # every failure path of its own, while this is owned only
                        # because the guard here exists. What keeps this one off
                        # the opener is `dir_fd=parent_fd` in
                        # `_create_member_file` — `open()`'s opener is called
                        # with `(path, flags)` and nothing else, so the directory
                        # descriptor would have to ride in on a closure. It
                        # could; this is a choice rather than an impossibility.
                        os.close(fd)
                        raise
                    with out:
                        # The mode is set on the DESCRIPTOR rather than on the
                        # path — by then the file is the one we just created, so
                        # there is nothing left for a name lookup to resolve to
                        # instead — and inside the `with`, so a failure here
                        # cannot leak the descriptor. It is set at all because
                        # `open`'s mode argument is filtered through the umask.
                        os.fchmod(out.fileno(), 0o644)
                        while True:
                            chunk = source.read(CHUNK)
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > self.max_build_bytes:
                                raise PublishError(
                                    413,
                                    f"archive expands beyond "
                                    f"{self.max_build_bytes} bytes")
                            digest.update(chunk)
                            out.write(chunk)
                    files["/".join(parts)] = digest.hexdigest()
                    seen_names[folded] = name
        finally:
            os.close(dest_fd)

        if refused_count:
            raise _refused_names_error(refused, refused_count)

    # -- staging -> publishable directory ----------------------------------
    def _finish_staging(self, pid, commit, staging: Path, files, digest) -> dict:
        """Validate meta.json and write everything the build page needs.

        `staging` is what the BUILD wrote (SPEC 8A.2 step 5), so the meta.json
        read here is the build's own — the same wire format the archive used to
        carry, produced one step closer to the model. Nothing else about this
        changed, which is the point of pointing the build at the directory that
        gets renamed into place.
        """
        raw = self._read_meta(staging)
        try:
            meta = render.build_meta(
                pid=pid, commit=commit, raw=raw, staging=staging, files=files,
                published=published_stamp(), dev=(commit == DEV_LINK))
        except ValueError as error:
            # render.py validates without knowing about HTTP; every way it can
            # refuse is "the push described something that is not there", i.e. 422.
            raise PublishError(422, str(error)) from error

        # meta.json only. The page shell is NOT written here: it is identical for
        # every build and it changes with the image, so a per-build copy served
        # under a commit URL's year of `immutable` would pin every published build
        # to the viewer markup of the day it was pushed. app.py renders it from
        # the template instead, the same way it serves `/`.
        (staging / "meta.json").write_text(
            json.dumps(meta, indent=1), encoding="utf-8")
        (staging / PAYLOAD_DIGEST_FILE).write_text(digest, encoding="utf-8")
        return meta

    @staticmethod
    def _read_meta(staging: Path) -> dict:
        path = staging / "meta.json"
        if not path.is_file():
            raise PublishError(422, "the build produced no meta.json")
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise PublishError(422, f"meta.json is not valid JSON: {error}") from error
        if not isinstance(raw, dict):
            raise PublishError(422, "meta.json must be a JSON object")
        return raw

    # -- project-level state -----------------------------------------------
    def empty(self) -> bool:
        """Has anything ever been published here? The ONE fact given anonymously.

        Read by `/start` (src/onboarding.py), which is the only route on this
        service that answers a question about the deployment without a token —
        so what this returns is a boolean and there is deliberately nothing here
        that could turn into a count, a name or a date.

        THE QUESTION IS "IS THERE A PROJECT", NOT "IS THERE A CARD". A project
        whose only build sits in the `dev` slot has no entry in `index.json` —
        the index is built from committed revisions (SPEC 7.6) — and this hub is
        emphatically not empty: somebody has pushed to it and `hammerola status`
        has something to say about it. Reading the index instead would call that
        hub empty and hand its owner instructions for a first push they have
        already made.

        A PROJECT DIRECTORY WITH NOTHING IN IT DOES NOT COUNT, and that is the
        difference between this and "does `project/` have entries". The reason
        is `build_staging`: it creates `project/<pid>/` before the build runs,
        and NOTHING removes that directory when the build then fails the gate —
        the caller removes the staging tree inside it and leaves the shell. So
        counting bare directories meant the first push of a new hub turned
        `empty` false FOREVER by failing, which lands on precisely the person
        the answer exists for: somebody whose very first build did not pass.
        The old wording defended the in-flight case with "which is what the
        answer will be a moment later anyway" — true of a build that succeeds,
        and false of one that does not.

        A directory in flight still counts, and now for a reason rather than by
        accident: the staging tree is INSIDE it while the build runs, so it is
        not empty. A `dev`-only project counts too, because its slot is a
        directory in there. What is left out is exactly the residue.

        FAILS CLOSED. An unreadable `project/` answers "not empty", so no
        onboarding block is shown on a hub that could not be asked; the
        alternative would be to tell somebody their hub is empty on the strength
        of an error.

        WHAT CONSUMES THE ANSWER is the sign-in page: `/start` serves this
        boolean and the door draws its block for an agent when it is true
        (`ui/src/HammerolaEntry.jsx`, issue #48; `src/onboarding.py` has
        the accounting). The fail-closed rule was pinned before that page
        existed, and it held: it is a property of the answer, so the page
        inherited it rather than having to reinvent it.
        """
        try:
            return not any(entry.is_dir() and any(entry.iterdir())
                           for entry in self.projects_dir.iterdir())
        except OSError as error:
            # Both `iterdir()`s are inside this, and the inner one is the reason
            # it is worth saying: a project directory the hub cannot read is not
            # evidence that the hub is empty, so it fails closed like the outer
            # one does.
            logger.warning(f"cannot tell whether {self.projects_dir} is empty: "
                           f"{error}")
            return False

    def builds_of(self, pid: str) -> list[dict]:
        """Every published COMMIT build of one project, newest first.

        The `dev` slot is skipped, and skipping it here is what keeps it out of
        `builds.json`, out of `/index.json` and out of `latest` in one place
        instead of three (SPEC 7.6). It is a directory with a real meta.json — it
        would otherwise be listed like any build — but it is not a version of the
        project, and history is a history of commits.

        Reads each build's own meta.json rather than a project-level list, so the
        directory tree stays the single source of truth: a build removed by hand,
        or one restored by hand, needs no bookkeeping anywhere else.

        Which is exactly why a meta.json here cannot be assumed to be one WE
        wrote. Everything downstream — `_switch_latest`,
        `render.builds_json`, `render.index_card` — subscripts these dicts
        directly, so one `{}` left by a half-finished restore used to take out the
        next publish of that project with a 500, after the build was already on
        disk and before `latest` had moved. A meta that cannot answer those
        questions is skipped exactly like an unreadable one: the build stops being
        listed, and the project keeps working.
        """
        pdir = self.projects_dir / pid
        if not pdir.is_dir():
            return []
        metas = []
        for entry in pdir.iterdir():
            if entry.name.startswith(".") or not entry.is_dir() or entry.is_symlink():
                continue
            if entry.name in RESERVED_BUILD_NAMES:
                continue
            meta_path = entry / "meta.json"
            if not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (ValueError, OSError, RecursionError):
                logger.warning(f"unreadable meta.json in {entry}")
                continue
            if not _usable_meta(meta, entry.name):
                logger.warning(
                    f"ignoring build {pid}/{entry.name}: its meta.json is not "
                    f"one this hub wrote (missing or wrong required fields)")
                continue
            metas.append(meta)
        metas.sort(key=_built_key, reverse=True)
        return metas

    def latest_commit(self, pid: str) -> str | None:
        """What `latest` currently points at, or None if it is not set."""
        try:
            return os.readlink(self.projects_dir / pid / LATEST_LINK)
        except OSError:
            return None

    def _switch_latest(self, pid: str) -> None:
        """Point `latest` at the newest build.

        Every build `builds_of` returns is a commit build — the local slot is not
        in that list — which is the whole rule `latest` exists to keep (SPEC 7.6):
        it is the link that gets pasted into chat, and it has to go on meaning
        "the project as of some commit".
        """
        metas = self.builds_of(pid)
        if not metas:
            return
        self._point(pid, LATEST_LINK, metas[0]["commit"])

    def _point(self, pid: str, name: str, target: str) -> None:
        """Move one pointer symlink, atomically.

        `os.symlink` to a temporary name followed by `os.rename` over the old link
        replaces it in ONE step. The obvious alternative — unlink the old link,
        then create the new one — leaves a window in which /project/<pid>/latest/
        is a 404, and that window is open on every single publish.

        The link is RELATIVE (just the build name). An absolute one would bake in
        the path the hub happened to have when it wrote it, and break the day the
        same tree is mounted somewhere else — which is exactly what the container
        does with /app/data.
        """
        pdir = self.projects_dir / pid
        tmp_link = pdir / f"{LATEST_LINK_PREFIX}{uuid.uuid4().hex}"
        os.symlink(target, tmp_link)
        os.rename(tmp_link, pdir / name)

    def _write_builds_json(self, pid: str) -> None:
        """Rewrite the build picker from what is actually on disk.

        Called AFTER the pointer has moved, so `latest` in the file names the
        build a reader following that link will actually land on. Temp file plus
        rename, so a reader sees the old list or the new one and never a
        half-written file.

        The local slot is not one of the entries and never will be — that is the
        point of it being a slot (SPEC 7.6) — but the picker still has to be able
        to OFFER it, so whether it is occupied is recorded alongside the list.
        Which is also why this runs for a project that has no commit builds yet:
        a local-only project has an empty history and a slot worth linking to.
        """
        metas = self.builds_of(pid)
        dev_meta = self._dev_meta(pid)
        if not metas and dev_meta is None:
            return
        picker = render.builds_json(pid, metas, dev=dev_meta is not None,
                                    latest=self.latest_commit(pid),
                                    fallback=dev_meta)
        renamed = self.project_title(pid)
        if renamed is not None:
            picker["title"] = renamed
        _atomic_write_json(self.projects_dir / pid / "builds.json", picker)

    def _dev_meta(self, pid: str) -> dict | None:
        """The local slot's meta.json, or None if the slot is empty.

        Read rather than assumed: with no commit build in the project it is the
        only source of the project's name and title, and `builds.json` needs
        those to render a header.
        """
        try:
            meta = json.loads(
                (self.projects_dir / pid / DEV_LINK / "meta.json"
                 ).read_text(encoding="utf-8"))
        except (ValueError, OSError, RecursionError):
            return None
        return meta if _usable_meta(meta, DEV_LINK) else None

    def _refresh_index(self) -> None:
        """Rebuild the root index.json from every project's newest COMMIT build.

        The local slot is left out for the same reason it does not move `latest`
        (SPEC 7.6): the front page is the most public surface there is, and a card
        that quietly starts describing uncommitted work from somebody's laptop is
        that promise broken in the one place everybody looks. It costs nothing to
        arrange — `builds_of` already excludes the slot. A project whose only
        build is a local one therefore has no card yet, which is the honest
        answer: nothing has been published from a commit.

        Two of the card's fields are properties of the PROJECT rather than of the
        build the rest of it comes from, so they are read here and handed over:
        whether the slot is occupied (the same `_dev_meta` call `_write_builds_json`
        makes, and the front page says only that it exists — never what is in it),
        and the oldest build still on disk, which is as close to "since when" as
        anything here gets. `render.index_card` says what each is for.
        """
        with self._index_lock:
            cards = []
            for pdir in sorted(self.projects_dir.iterdir()):
                if pdir.name.startswith(".") or not pdir.is_dir():
                    continue
                metas = self.builds_of(pdir.name)
                if metas:
                    # `builds_of` sorts newest first, so the last entry is the
                    # oldest build — and `built` is required of every meta it
                    # returns, which is what makes the subscript safe.
                    card = render.index_card(
                        metas[0],
                        dev=self._dev_meta(pdir.name) is not None,
                        first_built=metas[-1]["built"],
                    )
                    renamed = self.project_title(pdir.name)
                    if renamed is not None:
                        card["title"] = renamed
                    cards.append(card)
            cards.sort(key=lambda c: c["built"], reverse=True)
            _atomic_write_json(self.root / "index.json", cards)

    # -- rename, and remove ------------------------------------------------
    def project_title(self, pid: str) -> str | None:
        """The title a rename gave this project, or None if nobody renamed it.

        None rather than the build's own title, so every caller can tell the two
        apart: an override REPLACES what the newest build says, and a caller that
        got a string back either way could not know whether it was doing that.

        Read off the volume on every call rather than cached. It is one small
        file, read on the two paths that rewrite `builds.json` and `index.json`
        — both already reading every build's meta.json — so a cache would buy
        nothing and would have to be invalidated from the publish path, which is
        the sort of coupling `data/` is deliberately free of.
        """
        try:
            payload = json.loads(
                (self.projects_dir / pid / PROJECT_TITLE_FILE
                 ).read_text(encoding="utf-8"))
        except (ValueError, OSError, RecursionError):
            return None
        if not isinstance(payload, dict):
            return None
        title = payload.get("title")
        return title if isinstance(title, str) and title else None

    def set_title(self, pid: str, title: str) -> bool:
        """Rename the project. True when it was renamed, False when there is no
        such project.

        THE ID IS NOT TOUCHED AND CANNOT BE. Every permanent URL of the project
        is built from the id (SPEC 3.1), the builds behind those URLs are served
        with a year of `immutable` and cannot be recalled, so renaming an id
        would break exactly the promise this service exists to keep. There is no
        route for it and there is not going to be one.

        Existence is decided by the project DIRECTORY, which is what every other
        project-level answer here uses (`_serve_pointer_page`, `builds_of`): a
        project whose builds somebody cleared out by hand is still a project.

        The picker and the index are rewritten from what is on disk, in that
        order and for the reason `publish_built` gives: the per-project file
        first, the site-wide one after it.
        """
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            if not pdir.is_dir():
                return False
            _atomic_write_json(pdir / PROJECT_TITLE_FILE,
                               {"title": title, "renamed": utcnow_iso()})
            self._write_builds_json(pid)
        self._refresh_index()
        return True

    def clear_title(self, pid: str) -> None:
        """Forget a rename, because a push has just said what the project is called.

        A build carries the title out of the project's own `project.json`
        (`cadbuild.project.load_project`), so a push is a fresh statement of the
        name and it is the more recent one. Without this, a rename made once
        would outrank every future push for ever — and the client's `rename`
        writes the new title into `project.json` as well, so the ordinary
        sequence keeps the name rather than reverting it.

        Best effort, and called from inside the publish path: a volume that will
        not take the unlink must not turn a published build into a failed one.
        """
        try:
            (self.projects_dir / pid / PROJECT_TITLE_FILE).unlink()
        except FileNotFoundError:
            return
        except OSError as error:
            logger.warning(f"could not clear the renamed title of {pid}: {error}")

    def remove_project(self, pid: str) -> dict | None:
        """Delete one project ENTIRELY. -> what was removed, or None if absent.

        THE WHOLE PROJECT AND NEVER ONE BUILD. Removing a single build breaks a
        permanent URL, which is the one thing the service promises; removing the
        project takes the promise away with the thing it was about. This is for
        "I made a test project and I am done with it", and it is meant to be the
        big rare hammer rather than a tidying tool (issue #26).

        THE CODE OF THE REMOVED REVISIONS GOES TOO, AND ONLY IF NOTHING ELSE
        POINTS AT IT. `sources/` is addressed by the digest of a source tree and
        not by project (SPEC 7.8), so the same tree published in two projects is
        one directory serving both. The invariant that store keeps is "an archive
        exists exactly when a published revision does", so leaving these behind
        would break it in the direction SPEC 7.8 names as the bad one: a stored
        tree with no revision behind it is code the hub cannot answer for.

        THE ORDER IS WHAT MAKES THE SCAN SAFE against a publish running at the
        same moment. The project tree goes first, then the digests still
        referenced by OTHER projects are collected, and only unreferenced ones
        are deleted. A concurrent publish of the same sources elsewhere either
        has already renamed its build directory into place — in which case the
        scan sees it and the archive stays — or has not, in which case it has not
        stored the archive either (`jobs._keep_the_code` runs after the publish)
        and stores it once we are done.

        The comment queue is NOT removed here: it lives under `data/comments/`,
        which belongs to CommentStore, and app.py removes both.
        """
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            if not pdir.is_dir():
                return None
            mine = self._digests_of(pid)
            builds = len(self.builds_of(pid))
            shutil.rmtree(pdir)

        referenced = set()
        try:
            for other in self.projects_dir.iterdir():
                if other.name.startswith(".") or not other.is_dir():
                    continue
                referenced |= self._digests_of(other.name)
        except OSError as error:
            # Nothing may be deleted on a scan that did not finish: an
            # incomplete answer to "what else points at this" is indistinguishable
            # from "nothing does", and acting on it removes the code of somebody
            # else's live revision.
            logger.warning(
                f"remove {pid}: the source store was left alone, because the "
                f"scan for other projects' revisions failed: {error}")
            mine = set()

        removed_sources = 0
        for digest in sorted(mine - referenced):
            try:
                shutil.rmtree(self.sources_dir / digest)
            except FileNotFoundError:
                continue
            except OSError as error:
                logger.warning(f"remove {pid}: could not remove the code of "
                               f"revision {digest}: {error}")
                continue
            removed_sources += 1

        self._refresh_index()
        logger.info(f"removed project {pid}: {builds} builds, "
                    f"{removed_sources} stored source trees")
        return {"pid": pid, "builds": builds, "sources": removed_sources}

    def _digests_of(self, pid: str) -> set:
        """Every payload digest recorded in one project's build directories.

        The `dev` slot is included. Its sources are never stored, so its digest
        normally matches nothing in `sources/` — but if the same tree was also
        published as a revision, that revision's directory carries the digest
        too, so including it changes no answer and leaving it out would be a
        special case to explain.
        """
        digests = set()
        try:
            entries = list((self.projects_dir / pid).iterdir())
        except OSError:
            return digests
        for entry in entries:
            if entry.name.startswith(".") or not entry.is_dir():
                continue
            if entry.is_symlink():
                continue
            digest = _read_digest(entry)
            if digest:
                digests.add(digest)
        return digests


def _usable_meta(meta, dir_name: str) -> bool:
    """Can everything downstream read this meta.json without a KeyError?

    The fields listed here are the ones `_switch_latest` and the two
    renderers subscript directly; a build whose meta cannot answer for all of them
    is not servable, so it is better left out of the list than allowed to break
    the next publish of the whole project.

    `commit` is also required to MATCH the directory it was found in. It is what
    `latest` is pointed at, so a mismatch — a build copied under a new name, a
    meta restored into the wrong directory — would produce a dangling symlink,
    i.e. the one failure the atomic switch exists to prevent.

    WHAT IT ASKS OF EACH FIELD IS WHAT THE SUBSCRIPT DOWNSTREAM NEEDS, and
    issue #75 moved two of them without moving the question. `views` replaced
    `variants` and `index_card` sums `v["gzip"]` over it, so that is asked of
    every entry. `parts` used to be an int on each view — the biggest of which
    was the card's part count — and is now the CATALOGUE, out of which the card
    counts the printables; so the type asked about has to move from the view to
    the record, and the field checked has to be the one actually read.
    `isinstance(v.get("parts"), list)` would be the shape of the old line with
    none of its content: nothing subscripts a view's key list here, while a
    record whose `kind` is missing is exactly what makes that count raise.
    """
    if not isinstance(meta, dict):
        return False
    for key in ("pid", "project", "title", "commit", "built", "published"):
        if not isinstance(meta.get(key), str):
            return False
    if meta["commit"] != dir_name:
        return False
    views = meta.get("views")
    if not isinstance(views, list) or not views:
        return False
    if not all(isinstance(v, dict) and isinstance(v.get("gzip"), int)
               for v in views):
        return False
    # Non-empty for the reason `render._catalogue` refuses an empty one on the
    # way in: the two are one decision, and a build this side accepted and that
    # side would not is a build published into a URL and left off every list.
    parts = meta.get("parts")
    if not isinstance(parts, dict) or not parts:
        return False
    return all(isinstance(record, dict) and isinstance(record.get("kind"), str)
               for record in parts.values())


def _payload_digest(files: dict) -> str:
    """A digest of WHAT WAS UPLOADED, independent of tar order and timestamps.

    What is uploaded is the model's SOURCE tree (SPEC 8A.2 step 5), so this is a
    digest of the source and not of the build: the same commit pushed twice is
    the same push, whatever wall clock the two builds happened to stamp into
    their output.

    Deliberately covers only the archive's own members, not the meta.json the
    hub rewrites from the build. That one is normalized by code which changes
    when the service is updated, so hashing it would turn a hub release into a
    spurious 409 on every retry of an already-published commit.
    """
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(files[name].encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _hash_output(directory: Path, names) -> dict:
    """`{relative path: sha256}` for the files a build declared it ships.

    The same shape `_unpack` produces — `{path: sha256}` — but not the same
    journey, and this said "because it feeds the same consumer" until
    2026-08-31, which is no longer so: `_unpack`'s mapping is of an upload's
    members and goes to `_payload_digest` alone. THIS one is what
    `render.build_meta` reads, and it is the only mapping that reaches it:
    build_meta decides whether a view or a download names a file that is really
    there by asking whether it is a KEY of this mapping.

    The names come from `BuildOutcome.files`, which the build process claimed and
    the PARENT then checked one by one — inside `directory`, in normal form, no
    symlink in any component, a regular file that exists (`runner._verified_files`).
    That check is why this can open them directly. Taking the list rather than
    walking the tree is also what keeps the mapping to what the build SHIPS: an
    output directory may hold files a build wrote and never declared, and a view
    file that was never declared has no business validating.

    WHAT THIS DOES NOT DO IS PRUNE, and issue #53 did not change it: publication
    is a whole-directory move — `os.rename(staging, final)` on the commit route,
    the two renames of `_swap_dev_slot` on the `dev` one — and nothing anywhere
    deletes a file that is not a key of this mapping. So a model can write an
    arbitrary file into its output, never declare it, and have it land at a
    permanent public URL without `render._check_declared_file` ever seeing the
    name. #53 closed the other half — the maps are all declared now, and a
    declared name has to be one the file server will answer — so read that as
    "nothing DECLARED can be unservable", never as "nothing undeclared can be
    served".

    WHAT HOLDS THE UNDECLARED HALF IS THE FILE SERVER, and it answers in more
    than one place. Read the list below as what is really there rather than as
    a claim of completeness: an undeclared file it lets through is served, and
    that is the accepted position rather than an oversight.

      * the NAME. `app._safe_name` asks `buildnames.unservable_reason` of every
        name requested under `/project/<pid>/<commit>/`, so a name that starts
        with a dot or carries a character of the C category is not served at
        all. That, and not the content type, is what covers a
        `.payload.sha256`-shaped name;
      * WHERE IT LANDS. `app._send_file` resolves the path and refuses anything
        outside `store.root` — on the RESOLVED path, because `latest` is a
        symlink and following it is the point;
      * WHAT IT IS, in TWO places rather than one, and reading them as one is
        what hid a descriptor leak for a round. A DIRECTORY is refused by the
        `open()` in `app._send_file` itself — `FileIO` fstats what it was handed
        and raises `IsADirectoryError` — so it never reaches the check below. A
        FIFO or a device passes the open and is refused by `stat.S_ISREG` on the
        handle. A model writes its own output directory and nothing on the build
        path stops it calling `makedirs` or `mkfifo` there, so both are
        reachable in practice — and the fifo is REACHED only because the open is
        `O_RDONLY | O_NONBLOCK`: a plain `open()` on a fifo blocks until a writer
        appears, which is the serving thread gone for good before anything gets
        to refuse it. THE PERIMETER OF THIS WHOLE LIST IS
        `/project/<pid>/<commit>/`, and outside it the hazard is open as a
        CLASS rather than at a countable set of places: anything that reads the
        volume with a plain `open`/`read_text` and no `S_ISREG` wedges its
        handler for good — the comment queue's listing, a rename, a delete, the
        two log routes, and that enumeration went stale once already, which is
        why it is not the point. `EDIT_TOKEN` in front of a route limits who
        pulls the trigger, never who lays the trap: it is laid by the BUILD.
        Issue #74 carries the inventory; when it closes, this comes out;
      * the TYPE. `app.build_content_type` serves the whitelist
        (`BUILD_CONTENT_TYPES`) as itself and hands back everything else as
        `application/octet-stream` with `Content-Disposition: attachment`.
    """
    files: dict[str, str] = {}
    for name in names:
        digest = hashlib.sha256()
        with open(directory / name, "rb") as handle:
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
        files[name] = digest.hexdigest()
    return files


def _read_digest(build_dir: Path) -> str | None:
    try:
        return (build_dir / PAYLOAD_DIGEST_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _atomic_write_json(path: Path, payload) -> None:
    """Write JSON so a reader sees the old file or the new one, never a torn one."""
    atomic_write_bytes(path, json.dumps(payload, indent=1).encode("utf-8"))


def atomic_write_bytes(path: Path, data: bytes, *, tmp_dir: Path = None) -> None:
    """Write bytes so a reader sees the old file or the new one, never a torn one.

    The fsync before the rename is what makes that true across a power loss as
    well as across a concurrent read: rename is atomic with respect to other
    processes either way, but without the flush the new NAME can reach the disk
    while the new CONTENT has not, and the file comes back empty after a crash.

    Public, unlike everything else in this module's private half, because the
    comment queue (SPEC 7A.3) lives outside a build directory but has exactly the
    same requirement: a reader must never see half a comment. One implementation
    of "temp file, fsync, rename" rather than two that drift apart.

    `tmp_dir` puts the temporary file somewhere other than beside the target. It
    has to be ON THE SAME FILESYSTEM or the rename stops being a rename — it
    becomes EXDEV, and this function raises rather than silently copying. The
    caller is `src/jobs.py`, which keeps its temporaries in `data/jobs/` instead
    of inside each job directory, so that the one thing that collects strays
    from that tree — `JobStore._sweep_strangers`, at startup — is looking where
    a leftover of a killed write actually lands. Inside a live job's directory
    nothing ever collects one.

    NOT `_sweep_leftovers`, which is the near miss worth naming: the sweep above
    this one walks `self.root` and the project directories, and `data/jobs/` is
    neither, so a `.wip-` file under it is invisible here however familiar the
    prefix looks. `JobStore._sweep_strangers` carries its own short cutoff for
    that prefix for exactly this reason.

    WHAT IT IS NOT is a defence against a build making one write fail. That was
    the reason it was first proposed and it does not work, so it is written down
    here to stop it being proposed again: `rename(tmp, dir/name)` needs write
    permission on the DESTINATION directory, exactly as `open(dir/tmp)` did, so
    `chmod 0500` on a job directory refuses both. Measured, not reasoned:
    PermissionError either way. The only layout that would defuse it is one
    where no per-job directory exists at all, and what makes a pointwise
    failure survivable here is instead that nothing shared between records is
    written per record at all (see `JobStore._rewrite_locked` in `src/jobs.py`).
    """
    parent = path.parent if tmp_dir is None else Path(tmp_dir)
    tmp = parent / f"{JSON_TMP_PREFIX}{path.name}-{uuid.uuid4().hex}"
    try:
        with open(tmp, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o644)
        os.rename(tmp, path)
    except BaseException:
        # The temp name is dot-prefixed, so a leftover is invisible to every
        # reader and would sit on the volume until the next startup sweep. That
        # is tolerable after a SIGKILL and not tolerable per failed request on a
        # PUBLIC endpoint, which is what the comment queue is.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    # And the DIRECTORY, because the rename is a change to the directory entry
    # rather than to the file. Flushing only the file leaves the new content
    # durable under a name that is not: after a power loss the old name can still
    # be the one on disk, which is precisely the outcome the sentence above
    # promises will not happen. Best effort — some filesystems refuse to fsync a
    # directory, and that is not a reason to fail a publish that has landed.
    try:
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError as error:
        logger.warning(f"could not fsync the directory of {path}: {error}")
