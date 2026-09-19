"""One uploaded tar, read into a directory, and everything it refuses.

A push arrives as a gzipped tar and is attacker-controlled the moment the
publish token leaks. This module is the door it comes through: it opens the
archive, walks it member by member and writes a source tree into a staging
directory `src/store.py` made. Nothing here knows what a project or a build is,
and nothing here is served.

WHAT IT REFUSES. Every one of these is a refusal of the whole push rather than
a skipped member, and that is the point: a skipped member produces a build that
is missing a file and looks fine.

  * a member name that is not a RELATIVE PATH of `SAFE_COMPONENT` components,
    `/`-separated and at most `MAX_PATH_DEPTH` deep. `../`, `/etc/passwd`,
    `a/../../b`, `a//b` and `a/./b` are all rejected on the name alone —
    before the member's TYPE is even considered — because no component may be
    empty, `.` or `..`, and none may start with a dot at all;
  * anything that is not a regular file. Links above all, but devices and
    fifos too; a directory ENTRY is skipped rather than refused, because
    directories are created by US, from the paths of the files that need them;
  * two members whose paths fold to one name on a filesystem ignoring case;
  * an archive carrying more members, longer names, heavier headers or more
    bytes than the ceilings below admit — each of which says what it was
    measured against;
  * an archive that is corrupt, that chains extended headers, that carries a
    sparse member, or that asks to be read in one enormous piece.

THE DISK IS NOT THE ARCHIVE, and the rule holds absolutely: a failure of the
archive is the pusher's and comes back as a refusal, while a failure of the
filesystem — ENOSPC above all — stays an OSError and becomes a 500. Answering
"your archive is corrupt" to a dying volume sends the pusher off to debug a
file that is fine. `_is_the_disk` is what keeps the two apart, including inside
the handlers that refuse by WHERE a failure happened rather than by its type.

It refuses with `PublishError` and imports nothing else from the service:
`store` imports this module, and the edge only goes that way.
"""

import errno
import gzip
import hashlib
import os
import re
import tarfile
import zlib
from pathlib import Path

from loguru import logger

from src.errors import PublishError

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
# `\Z` for the same reason `store.SAFE_ID` gives: `$` also matches just before a
# trailing newline, so `^...$` would let "model.stl\n" through.
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
# `unpack` spells out. Getting this set wrong in the generous direction is how a
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
    pusher off to debug a file that is fine. That is the rule `unpack` states
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
                # Not the archive. Let it go up to `unpack`'s own OSError arm,
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
    # No `close`: the stream is closed by `unpack`, which opened it, and a
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


def unpack(body_path: Path, dest: Path, max_build_bytes: int) -> dict:
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
    `store` makes later would then fail with a confusing message about a broken
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
    # the arm, exactly one kind of disk failure in `unpack` would reach the
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
            stream, max_build_bytes + ARCHIVE_OVERHEAD_BYTES)
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
            _extract_members(tar, counted, dest, real_dest, files,
                             max_build_bytes)
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


def _extract_members(tar, counted, dest: Path, real_dest: str,
                     files: dict, max_build_bytes: int) -> None:
    """The member loop of `unpack`. Fills `files` with path -> sha256.

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
                    if total > max_build_bytes:
                        raise PublishError(
                            413,
                            f"archive expands beyond "
                            f"{max_build_bytes} bytes")
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
                    # `safeio.nonblocking` argues against this exact shape and
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
                        if total > max_build_bytes:
                            raise PublishError(
                                413,
                                f"archive expands beyond "
                                f"{max_build_bytes} bytes")
                        digest.update(chunk)
                        out.write(chunk)
                files["/".join(parts)] = digest.hexdigest()
                seen_names[folded] = name
    finally:
        os.close(dest_fd)

    if refused_count:
        raise _refused_names_error(refused, refused_count)
