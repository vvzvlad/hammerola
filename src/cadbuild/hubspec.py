#!/usr/bin/env python3
"""Limits and names fixed by cad_snapshot_hub docs/SPEC.md sections 7 and 7.1.

Mirrored here so a bad model fails locally with a readable message instead of
coming back as an opaque 422 from the hub. Do not improvise: the hub validates
every field.
"""

import re


# Hub-side limits, mirrored so a bad model fails here with a readable message
# instead of coming back as an opaque 422 from the hub (SPEC 7.1).
MEMBER_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
LABEL_RE = re.compile(r"\A[A-Za-z0-9._-]{1,32}\Z")
RESERVED_NAMES = {"meta.json", "index.html", "metrics.json"}
MAX_BUILD_BYTES = 64 * 1024 * 1024

# The build name `make build` publishes under. Reserved on the hub side, where
# it is a pointer that gets overwritten rather than a snapshot id (SPEC 7.6).
DEV_LABEL = "dev"

# The project id `cad-publish init --test` writes. Everything about it is on
# purpose:
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
# than in init_project.py where it is written: project.py is what has to
# recognise it, and importing the one-shot init command from the build path to
# read one string would point the dependency backwards. Two spellings of it
# would mean a test id the build no longer recognises, and the entire safety of
# the flag is that refusal.
TEST_ID = "local-test-do-not-publish"

# The title that goes with it, when project.json carries none. Russian on
# purpose, unlike every other string in this package: this is not interface
# text but a project TITLE, and project_title.title_problem requires Cyrillic
# words in front of the slug. An English one would make `cad-publish preview`
# warn about the title of a checkout that is deliberately not a project. The
# slug half is formatted with the directory name for the same rule.
TEST_TITLE = "Локальный прогон шаблона, не проект ({slug})"
